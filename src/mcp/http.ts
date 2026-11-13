import {
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { getUser, type UserRow } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { RateLimiter } from '../lib/http.ts';
import { SCOPE } from '../oauth/errors.ts';
import { protectedResourceMetadataUrl } from '../oauth/metadata.ts';
import { verifyAccessTokenFor } from '../oauth/tokens.ts';
import { allowlist, type Deps } from '../types.ts';

// An MCP endpoint of the platform: Streamable HTTP behind the platform's own bearer tokens.
// Every endpoint (the builder on the control plane, later one per app) shares the same
// authorization server; a token is only good at the endpoint it was issued for.

/** The canonical URI (RFC 8707 resource) of the builder's endpoint. */
export const builderResource = (config: Pick<Config, 'controlOrigin'>): string => `${config.controlOrigin}/mcp`;

/** A whole app travels in one `write_files` call (3 MiB of sources at most, plus JSON escaping). */
const MAX_BODY = 6 * 1024 * 1024;

/** MCP clients running in a browser (claude.ai itself calls from its servers) need these to read answers. */
export const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'MCP-Protocol-Version',
    'Mcp-Method',
    'Mcp-Name',
    'Mcp-Session-Id',
  ],
  exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  maxAge: 86_400,
});

/**
 * Serves one MCP endpoint. `build` makes the server for the member a request's token stands
 * for; it is called for every request, so what a member may do is never older than the request.
 */
export function mcpEndpoint(
  deps: Deps,
  resource: string,
  build: (caller: UserRow) => McpServer,
  /** Asked for every request: false ends it (the member lost the app, or the app its tools). */
  mayUse: (caller: UserRow) => boolean = () => true,
) {
  const { db, config } = deps;
  const isAllowed = allowlist(config);
  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const access = verifyAccessTokenFor(db, token, isAllowed, resource);
        if (!access) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token');
        return {
          token,
          clientId: access.clientId,
          scopes: access.scopes,
          expiresAt: access.expiresAt,
          resource: new URL(access.resource),
          extra: { userId: access.userId, grantId: access.grantId },
        };
      },
    },
    requiredScopes: [SCOPE],
    resourceMetadataUrl: protectedResourceMetadataUrl(resource),
    expectedResource: new URL(resource),
  });
  const handler = createMcpHandler(
    (context) => {
      const userId = context.authInfo?.extra?.userId;
      const caller = typeof userId === 'number' ? getUser(db, userId) : undefined;
      if (!caller) throw new Error('MCP request without a verified caller');
      return build(caller);
    },
    { onerror: (error) => console.error('mcp error:', error.message), maxRequestBodySize: MAX_BODY },
  );
  // A leaked token must not be able to keep the runner busy.
  const perGrant = new RateLimiter(120, 60_000);
  return async (c: Context) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    if (!perGrant.take(String(auth.extra?.grantId))) {
      return c.json({ error: 'rate_limited', message: 'Too many requests for this connection, slow down.' }, 429, {
        'Retry-After': '60',
      });
    }
    const userId = auth.extra?.userId;
    const caller = typeof userId === 'number' ? getUser(db, userId) : undefined;
    if (!caller || !mayUse(caller)) return c.json({ error: 'forbidden', message: 'Not available to you.' }, 403);
    return handler.fetch(c.req.raw, { authInfo: auth });
  };
}
