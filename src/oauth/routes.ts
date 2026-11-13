import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getUser, type UserRow } from '../auth/users.ts';
import { translator } from '../i18n.ts';
import { clientIp, isSameOrigin, isTopLevelNavigation, RateLimiter } from '../lib/http.ts';
import { messagePage } from '../pages/layout.ts';
import { allowlist, type ControlEnv } from '../types.ts';
import {
  authenticateClient,
  findClient,
  isLoopbackRedirect,
  redirectMatches,
  registerClient,
  uriForLog,
  type OAuthClient,
} from './clients.ts';
import type { OAuthDeps } from './config.ts';
import { OAuthFailure, SCOPE } from './errors.ts';
import { authorizationServerMetadata } from './metadata.ts';
import { consentPage, handOverPage } from './pages.ts';
import { isValidPkceChallenge } from './pkce.ts';
import {
  deletePendingRequest,
  exchangeCode,
  hasRoomForParkedRequest,
  isPendingRequestId,
  issueCode,
  loadPendingRequest,
  refreshTokens,
  revokeToken,
  savePendingRequest,
} from './tokens.ts';

// The OAuth 2.1 authorization server of the platform, for remote MCP clients. It lives on
// the control plane and issues tokens for every MCP endpoint of the instance; which
// endpoints exist, and who may use each, is the resolver's knowledge, not this module's.
//
//   GET  /oauth/authorize?client_id=…&resource=…   checks the request; signs the visitor in
//                                                  first when needed; then keeps the request
//                                                  and redirects to
//   GET  /oauth/authorize?request=<id>             the consent page
//   POST /oauth/authorize                          the member's answer, sent back to the client

/**
 * Describes a protected resource (RFC 8707: the URI of an MCP endpoint) for one member,
 * or returns null when the URI is not a resource of this platform or this member may not
 * use it. A grant is bound to the exact string that resolved.
 */
export type ResourceResolver = (resource: string, user: UserRow) => { name: string; description: string } | null;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** What the control plane accepts as `next` on /auth/start. A longer request is parked instead. */
const LOGIN_NEXT_MAX = 1500;

function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.href;
}

function parseBasic(header: string | undefined): { id: string; secret: string } | null {
  const match = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header) : null;
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
      secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
    };
  } catch {
    return null;
  }
}

/** Token and revocation requests: form-encoded by the specification, JSON from some clients. */
async function formBody(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  const result: Record<string, string> = {};
  if (type.includes('application/json')) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [key, value] of Object.entries(json ?? {})) if (typeof value === 'string') result[key] = value;
    return result;
  }
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  for (const [key, value] of Object.entries(form)) if (typeof value === 'string') result[key] = value;
  return result;
}

function oauthError(c: Context, error: OAuthFailure, basicAuth = false) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (error.status === 401 && basicAuth) headers['WWW-Authenticate'] = 'Basic realm="socle"';
  return c.json(error.body(), error.status, headers);
}

/** RFC 8707 §2: an absolute URI without fragment. Whether it is one of ours is the resolver's answer. */
function isResourceUri(value: string): boolean {
  if (value.length > 2000 || value.includes('#')) return false;
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mount on the control-plane app with `app.route('/', …)`, after its session middleware:
 * the consent pages read the signed-in member from `c.get('session')`.
 */
export function oauthRoutes(deps: OAuthDeps, resolve: ResourceResolver): Hono<ControlEnv> {
  const { db, config } = deps;
  const issuer = config.controlOrigin;
  const isAllowed = allowlist(config);
  const fetchImpl = deps.fetch ?? fetch;
  const t = translator(config.locale);
  const app = new Hono<ControlEnv>();
  const registerLimiter = new RateLimiter(20, 3600_000);
  const tokenLimiter = new RateLimiter(120, 60_000);
  const authorizeLimiter = new RateLimiter(60, 60_000);

  /** The resolver, for the token endpoint: a code or a refresh token only becomes tokens for an endpoint that still exists for that member. */
  const mayUse = (resource: string, userId: number) => {
    const user = getUser(db, userId);
    return user !== undefined && resolve(resource, user) !== null;
  };

  const errorPage = (c: Context, status: 400 | 401 | 403 | 429, title: string, message: string) =>
    c.html(messagePage(config.locale, title, message), status);
  const expired = (c: Context) =>
    errorPage(c, 400, t('Request expired'), t('Start the connection again from your application.'));
  const toSignIn = (c: Context, next: string) => c.redirect(`/auth/start?next=${encodeURIComponent(next)}`, 302);

  // Clients that run in a browser read the metadata and call the token endpoints from
  // their own origin. None of these routes looks at a cookie. Registration stays out: a web
  // page has no business registering clients in a visitor's name, so that route has no CORS
  // headers and refuses what a page of another site can send without them (see below).
  const openCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'MCP-Protocol-Version'],
    maxAge: 86_400,
  });
  for (const path of ['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/revoke']) {
    app.use(path, openCors);
  }

  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(config)));

  app.post('/oauth/register', async (c) => {
    // A page of another site can post text without asking (no preflight), in its visitor's
    // name and from their address: only JSON sent as JSON is read, and never from such a page.
    // Checked before the limiter: what a page sends must not count against its visitor either.
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'none' && site !== 'same-origin') {
      return oauthError(c, new OAuthFailure('invalid_client_metadata', 'registration is not open to web pages', 403));
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return oauthError(c, new OAuthFailure('invalid_client_metadata', 'send the metadata as application/json'));
    }
    if (!registerLimiter.take(clientIp(c))) {
      return oauthError(c, new OAuthFailure('invalid_client_metadata', 'too many registrations, retry later', 429));
    }
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(registerClient(db, config.oauth, body), 201, NO_STORE);
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthError(c, error);
      throw error;
    }
  });

  /** The consent page of a request kept earlier. */
  const showConsent = async (c: Context<ControlEnv>, requestId: string) => {
    if (!isPendingRequestId(requestId)) return expired(c);
    const session = c.get('session');
    if (!session) return toSignIn(c, `/oauth/authorize?request=${requestId}`);
    const request = loadPendingRequest(db, requestId, session.idHash, { bind: true });
    if (!request) return expired(c);
    let client: OAuthClient;
    try {
      client = await findClient(db, config.oauth, request.clientId, fetchImpl);
    } catch (error) {
      if (!(error instanceof OAuthFailure)) throw error;
      return errorPage(c, 400, t('Unknown application'), t('Start the connection again from your application.'));
    }
    // Always asked again: a request parked before sign-in has not been resolved for anyone yet.
    const resource = resolve(request.resource, session.user);
    if (!resource) {
      deletePendingRequest(db, requestId);
      return c.redirect(
        withParams(request.redirectUri, {
          error: 'invalid_target',
          error_description: 'unknown resource',
          state: request.state,
          iss: issuer,
        }),
        302,
      );
    }
    const target = new URL(request.redirectUri);
    c.header('Cache-Control', 'no-store');
    return c.html(
      consentPage(config.locale, t, {
        clientName: client.clientName,
        verifiedHost: client.kind === 'cimd' ? new URL(client.clientId).hostname : null,
        redirect: isLoopbackRedirect(target)
          ? { kind: 'loopback', host: target.host }
          : { kind: 'web', host: target.hostname },
        email: session.user.email,
        requestId,
        resource,
      }),
    );
  };

  app.get('/oauth/authorize', async (c) => {
    // This route keeps a row for a signed-in member: like the sign-on steps, it only
    // answers the page a tab navigates to, never a request a sibling origin makes in the
    // background (clients without these headers are not browsers and carry no session).
    if (!isTopLevelNavigation(c)) return c.text('Navigation expected', 400);
    if (!authorizeLimiter.take(clientIp(c))) {
      return errorPage(c, 429, t('Too many requests'), t('Try again in a minute.'));
    }
    const q = c.req.query();
    if (q.request !== undefined) return showConsent(c, q.request);

    if (!q.client_id) return errorPage(c, 400, t('Invalid request'), t('The client_id parameter is missing.'));
    let client: OAuthClient;
    try {
      client = await findClient(db, config.oauth, q.client_id, fetchImpl);
    } catch (error) {
      if (!(error instanceof OAuthFailure)) throw error;
      return errorPage(
        c,
        400,
        t('Unknown application'),
        t('This application is not recognised ({reason}).', { reason: error.description }),
      );
    }
    const provided = q.redirect_uri !== undefined;
    const redirectUri = provided ? q.redirect_uri! : client.redirectUris.length === 1 ? client.redirectUris[0]! : null;
    if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
      return errorPage(c, 400, t('Return address refused'), t('The return address does not match the application.'));
    }
    // From here on, errors are reported to the client through the redirect.
    const back = (error: string, description: string) =>
      c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state, iss: issuer }), 302);
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!q.code_challenge || !isValidPkceChallenge(q.code_challenge) || q.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (q.state !== undefined && q.state.length > 2000) return back('invalid_request', 'state is too long');
    // Tokens of this server are good at one endpoint only, so the client has to name it.
    if (q.resource === undefined || !isResourceUri(q.resource)) {
      return back('invalid_target', 'the resource parameter is required: the URI of the MCP server (RFC 8707)');
    }
    const request = {
      clientId: client.clientId,
      redirectUri,
      redirectUriProvided: provided,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      scope: SCOPE,
      resource: q.resource,
    };

    const session = c.get('session');
    if (!session) {
      // Sign in first, and come back here with the same request. Nothing is stored for a
      // visitor: the request travels in the `next` of the sign-in, rebuilt from the
      // parameters this server understands.
      const again = new URLSearchParams({ response_type: 'code', client_id: q.client_id });
      if (provided) again.set('redirect_uri', redirectUri);
      again.set('code_challenge', q.code_challenge);
      again.set('code_challenge_method', 'S256');
      again.set('resource', q.resource);
      if (q.state !== undefined) again.set('state', q.state);
      const next = `/oauth/authorize?${again}`;
      if (next.length <= LOGIN_NEXT_MAX) return toSignIn(c, next);
      // Too long to travel (a very long state, usually): parked here, in bounded number.
      if (!hasRoomForParkedRequest(db)) {
        return errorPage(c, 429, t('Too many requests'), t('Try again in a few minutes.'));
      }
      return toSignIn(c, `/oauth/authorize?request=${savePendingRequest(db, request, null)}`);
    }
    if (!resolve(q.resource, session.user)) return back('invalid_target', 'unknown resource');
    // Kept server-side and shown at an address without parameters: the answer then names
    // one request this session was shown, and reloading the page asks nothing new.
    return c.redirect(`/oauth/authorize?request=${savePendingRequest(db, request, session.idHash)}`, 302);
  });

  /**
   * Sends the browser back to the client with the answer. Not an HTTP redirect: this is
   * the response to a form, and browsers apply the page's `form-action 'self'` to the
   * redirects that follow a form submission too. A page that moves on by itself is an
   * ordinary navigation, which no policy of the control plane has to open up.
   */
  const handOver = (c: Context, url: string) => {
    c.header('Cache-Control', 'no-store');
    return c.html(handOverPage(config.locale, t, url));
  };

  app.post('/oauth/authorize', async (c) => {
    if (!isSameOrigin(c, config.controlOrigin)) {
      return errorPage(c, 403, t('Request refused'), t('Unexpected origin.'));
    }
    const session = c.get('session');
    if (!session) {
      return errorPage(
        c,
        401,
        t('Session expired'),
        t('Sign in again, then start the connection again from your application.'),
      );
    }
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const requestId = typeof form.request === 'string' ? form.request : '';
    const request = loadPendingRequest(db, requestId, session.idHash, { bind: false });
    if (!request) return expired(c);
    deletePendingRequest(db, requestId);
    const answer = (params: Record<string, string>) =>
      handOver(c, withParams(request.redirectUri, { ...params, state: request.state, iss: issuer }));
    if (form.decision !== 'allow') {
      return answer({ error: 'access_denied', error_description: 'The user denied access' });
    }
    // The member may have lost the resource since the page was shown.
    if (!resolve(request.resource, session.user)) {
      return answer({ error: 'invalid_target', error_description: 'unknown resource' });
    }
    const code = issueCode(db, request, session.user.id);
    console.info(`oauth: ${session.user.email} authorized client ${uriForLog(request.clientId)}`);
    return answer({ code });
  });

  app.post('/oauth/token', async (c) => {
    if (!tokenLimiter.take(clientIp(c))) {
      return oauthError(c, new OAuthFailure('invalid_request', 'too many requests, retry later', 429));
    }
    const body = await formBody(c);
    const basic = parseBasic(c.req.header('authorization'));
    try {
      const client = await authenticateClient(
        db,
        config.oauth,
        { basic, clientId: body.client_id, clientSecret: body.client_secret },
        fetchImpl,
      );
      const ttl = config.oauth;
      let outcome;
      if (body.grant_type === 'authorization_code') {
        if (!body.code) throw new OAuthFailure('invalid_request', 'code is required');
        outcome = exchangeCode(
          db,
          client,
          {
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
            resource: body.resource,
          },
          isAllowed,
          ttl,
          mayUse,
        );
      } else if (body.grant_type === 'refresh_token') {
        if (!body.refresh_token) throw new OAuthFailure('invalid_request', 'refresh_token is required');
        outcome = refreshTokens(
          db,
          client,
          { refreshToken: body.refresh_token, scope: body.scope, resource: body.resource },
          isAllowed,
          ttl,
          mayUse,
        );
      } else {
        throw new OAuthFailure('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      }
      if (!outcome.ok) throw outcome.error;
      return c.json(outcome.tokens, 200, NO_STORE);
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthError(c, error, basic !== null);
      throw error;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    if (!tokenLimiter.take(clientIp(c))) {
      return oauthError(c, new OAuthFailure('invalid_request', 'too many requests, retry later', 429));
    }
    const body = await formBody(c);
    const basic = parseBasic(c.req.header('authorization'));
    try {
      const client = await authenticateClient(
        db,
        config.oauth,
        { basic, clientId: body.client_id, clientSecret: body.client_secret },
        fetchImpl,
      );
      if (!body.token) throw new OAuthFailure('invalid_request', 'token is required');
      revokeToken(db, client, body.token);
      return c.body(null, 200, NO_STORE);
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthError(c, error, basic !== null);
      throw error;
    }
  });

  return app;
}
