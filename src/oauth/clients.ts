import * as z from 'zod';
import { get, run, type Db } from '../db/database.ts';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.ts';
import type { OAuthConfig } from './config.ts';
import { OAuthFailure, SCOPE } from './errors.ts';

// Client registration for MCP clients: Client ID Metadata Documents (fetched only
// from trusted hosts) and Dynamic Client Registration (deprecated but still what
// many clients use), restricted to the configured https callbacks and loopback
// redirects.

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClient {
  clientId: string;
  kind: 'dcr' | 'cimd';
  /** As the client declared it; null when it gave none (pages then say so in the instance's language). */
  clientName: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
}

interface ClientRow {
  client_id: string;
  kind: 'dcr' | 'cimd';
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  token_endpoint_auth_method: AuthMethod;
  expires_at: string | null;
}

type Settings = Pick<OAuthConfig, 'redirectUris' | 'cimdHosts'>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_DCR_CLIENTS = 500;
const CIMD_FAILURE_CACHE_MS = 5 * 60 * 1000;
const CIMD_STALE_GRACE_MS = 10 * 60 * 1000;
/** How long after its last successful read a document may still be used while its host is down. */
const CIMD_STALE_MAX_MS = 60 * 60 * 1000;
/** client_id → when its document was last read successfully (by this process). */
const lastGoodFetch = new Map<string, number>();
/** client_id → time until which a failed metadata fetch is not retried. */
const cimdFailures = new Map<string, number>();

export function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Exact host match; an entry starting with "." matches that domain's subdomains. */
function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => (allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed));
}

/**
 * A client id or a URI someone sent, as it may appear in a log line or an error
 * description: without its query string (the log never holds one), cut to a length, and
 * nothing at all of a value that is neither a URL nor a plain identifier.
 */
export function uriForLog(raw: string): string {
  if (/^[\w.-]{1,100}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 200);
  } catch {
    return '(not a URL)';
  }
}

/**
 * Returns an error message, or null when the redirect URI is acceptable:
 * loopback http (clients running on the member's own machine) or one of the
 * exact https callbacks configured.
 */
export function checkRedirectUri(raw: string, allowedHttps: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'redirect URI is not an absolute URL';
  }
  if (url.hash || raw.includes('#')) return 'redirect URIs must not contain a fragment';
  if (url.username || url.password) return 'redirect URIs must not contain credentials';
  if (isLoopbackRedirect(url)) return null;
  if (url.protocol !== 'https:') {
    return `redirect URI must use https or a loopback http address: ${uriForLog(raw)}`;
  }
  if (!allowedHttps.includes(url.href)) return `redirect URI ${uriForLog(raw)} is not allowed on this server`;
  return null;
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  return (
    isLoopbackRedirect(a) &&
    isLoopbackRedirect(b) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    !b.hash &&
    !b.username &&
    !b.password
  );
}

function fromRow(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    kind: row.kind,
    clientName: row.client_name || null,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    authMethod: row.token_endpoint_auth_method,
    secretHash: row.client_secret_hash,
  };
}

const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
    client_name: z.string().trim().max(100).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).max(10).optional(),
    response_types: z.array(z.string()).max(10).optional(),
    scope: z.string().max(1000).optional(),
    application_type: z.string().max(20).optional(),
    client_uri: z.string().max(2000).optional(),
    logo_uri: z.string().max(2000).optional(),
  })
  .loose();

const SUPPORTED_AUTH: readonly AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

export function registerClient(db: Db, settings: Settings, body: unknown): Record<string, unknown> {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OAuthFailure('invalid_client_metadata', `${issue?.path.join('.') || 'body'}: ${issue?.message}`);
  }
  const request = parsed.data;
  for (const uri of request.redirect_uris) {
    const problem = checkRedirectUri(uri, settings.redirectUris);
    if (problem) {
      console.warn(`oauth: registration refused (${problem})`);
      throw new OAuthFailure('invalid_redirect_uri', problem);
    }
  }
  const authMethod = (request.token_endpoint_auth_method ?? 'client_secret_basic') as AuthMethod;
  if (!SUPPORTED_AUTH.includes(authMethod)) {
    throw new OAuthFailure('invalid_client_metadata', 'this token_endpoint_auth_method is not supported');
  }
  if (request.grant_types && !request.grant_types.includes('authorization_code')) {
    throw new OAuthFailure('invalid_client_metadata', 'grant_types must include authorization_code');
  }
  if (request.response_types && !request.response_types.includes('code')) {
    throw new OAuthFailure('invalid_client_metadata', 'response_types must include code');
  }
  const count = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'dcr'")?.n ?? 0;
  if (count >= MAX_DCR_CLIENTS) {
    // Anyone may register: when the table is full, make room by evicting the oldest
    // client that no member ever authorized, and refuse when there is none.
    const evicted = run(
      db,
      `DELETE FROM oauth_clients WHERE client_id = (
         SELECT client_id FROM oauth_clients WHERE kind = 'dcr'
            AND client_id NOT IN (SELECT client_id FROM oauth_grants)
          ORDER BY created_at LIMIT 1)`,
    );
    if (evicted.changes === 0) throw new OAuthFailure('invalid_client_metadata', 'too many registered clients', 429);
  }

  const clientId = `socle_client_${randomToken(18)}`;
  const secret = authMethod === 'none' ? null : randomToken(32);
  const issuedAt = Math.floor(Date.now() / 1000);
  const registration: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: request.client_name || undefined,
    redirect_uris: request.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPE,
  };
  if (request.application_type) registration.application_type = request.application_type;
  run(
    db,
    `INSERT INTO oauth_clients (client_id, kind, client_secret_hash, client_name, redirect_uris,
       token_endpoint_auth_method, registration, created_at)
     VALUES (:id, 'dcr', :secret, :name, :uris, :method, :registration, :now)`,
    {
      id: clientId,
      secret: secret ? sha256(secret) : null,
      name: request.client_name || null,
      uris: JSON.stringify(request.redirect_uris),
      method: authMethod,
      registration: JSON.stringify(registration),
      now: new Date().toISOString(),
    },
  );
  return secret ? { ...registration, client_secret: secret, client_secret_expires_at: 0 } : registration;
}

const cimdSchema = z
  .object({
    client_id: z.string(),
    client_name: z.string().trim().max(100).optional(),
    redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
    token_endpoint_auth_method: z.string().optional(),
  })
  .loose();

const MAX_CIMD_BYTES = 64 * 1024;

function cacheSeconds(header: string | null): number {
  const maxAge = header ? /max-age=(\d+)/i.exec(header)?.[1] : undefined;
  const seconds = maxAge ? Number(maxAge) : 3600;
  return Math.min(Math.max(seconds, 300), 86_400);
}

/**
 * A metadata document that could not be used, once a request for it was sent. `transient`:
 * its host did not answer or failed (as opposed to a document that is gone or wrong).
 */
class DocumentFailure extends OAuthFailure {
  readonly transient: boolean;
  constructor(description: string, transient = false) {
    super('invalid_client', description);
    this.transient = transient;
  }
}

/** The body of a response as text, read no further than `limit` bytes. Null beyond it. */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchClientMetadata(
  db: Db,
  settings: Settings,
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<OAuthClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthFailure('invalid_client', 'client_id is not a valid URL');
  }
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash || url.username || url.password) {
    throw new OAuthFailure('invalid_client', 'client metadata URLs must be https with a path');
  }
  // Checked before any request leaves: this server only ever fetches from the hosts it was told to trust.
  if (!hostAllowed(url.hostname, settings.cimdHosts)) {
    throw new OAuthFailure(
      'invalid_client',
      `client metadata host ${url.hostname.slice(0, 100)} is not trusted by this server`,
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new DocumentFailure('client metadata document could not be fetched', true);
  }
  if (!response.ok) {
    // 5xx: the host is in trouble. 4xx: the document was withdrawn, which is an answer.
    throw new DocumentFailure(`client metadata document returned ${response.status}`, response.status >= 500);
  }
  const text = await readBounded(response, MAX_CIMD_BYTES).catch(() => {
    throw new DocumentFailure('client metadata document could not be fetched', true);
  });
  if (text === null) throw new DocumentFailure('client metadata document is too large');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DocumentFailure('client metadata document is not JSON');
  }
  const parsed = cimdSchema.safeParse(json);
  if (!parsed.success) throw new DocumentFailure('client metadata document is missing required fields');
  const doc = parsed.data;
  if (doc.client_id !== clientId) throw new DocumentFailure('client_id does not match the document URL');
  const method = doc.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') {
    throw new DocumentFailure('only token_endpoint_auth_method none is supported for metadata documents');
  }
  // Only the configured callbacks and loopback, whatever else the document lists.
  const redirectUris = doc.redirect_uris.filter((uri) => checkRedirectUri(uri, settings.redirectUris) === null);
  if (redirectUris.length === 0) {
    throw new DocumentFailure('none of the redirect URIs of the metadata document is allowed');
  }
  lastGoodFetch.set(clientId, Date.now());
  const expiresAt = new Date(Date.now() + cacheSeconds(response.headers.get('cache-control')) * 1000).toISOString();
  const name = doc.client_name || url.hostname;
  run(
    db,
    `INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris, token_endpoint_auth_method, registration, created_at, expires_at)
     VALUES (:id, 'cimd', :name, :uris, 'none', :registration, :now, :expires)
     ON CONFLICT(client_id) DO UPDATE SET client_name = :name, redirect_uris = :uris, registration = :registration, expires_at = :expires`,
    {
      id: clientId,
      name,
      uris: JSON.stringify(redirectUris),
      registration: JSON.stringify(doc),
      now: new Date().toISOString(),
      expires: expiresAt,
    },
  );
  return {
    clientId,
    kind: 'cimd',
    clientName: name,
    redirectUris,
    authMethod: 'none',
    secretHash: null,
  };
}

/** Looks a client up (fetching its metadata document when needed). Throws invalid_client. */
export async function findClient(
  db: Db,
  settings: Settings,
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<OAuthClient> {
  if (!clientId || clientId.length > 2000) throw new OAuthFailure('invalid_client', 'unknown client');
  const row = get<ClientRow>(db, 'SELECT * FROM oauth_clients WHERE client_id = :id', { id: clientId });
  if (clientId.startsWith('https://')) {
    const cached = row && row.kind === 'cimd' ? row : undefined;
    if (cached?.expires_at && Date.parse(cached.expires_at) > Date.now()) return fromRow(cached);
    // While its host is down, the last document read may still be used: for an hour at most
    // after it was last read, never across a restart of this server, and not at all once the
    // document was found withdrawn or wrong (that forgets the last good read).
    const staleUntil = cached ? (lastGoodFetch.get(clientId) ?? -Infinity) + CIMD_STALE_MAX_MS : -Infinity;
    const useStale = (reason: string) => {
      run(db, 'UPDATE oauth_clients SET expires_at = :expires WHERE client_id = :id', {
        expires: new Date(Math.min(Date.now() + CIMD_STALE_GRACE_MS, staleUntil)).toISOString(),
        id: clientId,
      });
      console.warn(`oauth: using stale metadata for ${uriForLog(clientId)} (${reason})`);
      return fromRow(cached!);
    };
    // A failure is remembered for a few minutes, for known clients as for unknown ones: a host
    // that just failed is not asked again by every request that names it.
    const failedUntil = cimdFailures.get(clientId);
    if (failedUntil && failedUntil > Date.now()) {
      if (Date.now() < staleUntil) return useStale('its host failed a moment ago');
      throw new OAuthFailure('invalid_client', 'client metadata document unavailable, retry later');
    }
    try {
      const client = await fetchClientMetadata(db, settings, clientId, fetchImpl);
      cimdFailures.delete(clientId);
      return client;
    } catch (error) {
      // Only a fetch that was attempted is remembered: an id that was refused before any
      // request left costs nothing to refuse again, and must not push real failures out.
      if (error instanceof DocumentFailure) {
        if (cimdFailures.size >= 1000) cimdFailures.delete(cimdFailures.keys().next().value!);
        cimdFailures.set(clientId, Date.now() + CIMD_FAILURE_CACHE_MS);
        if (!error.transient) lastGoodFetch.delete(clientId);
        else if (Date.now() < staleUntil) return useStale(error.description);
      }
      console.warn(`oauth: client metadata refused for ${uriForLog(clientId)} (${(error as Error).message})`);
      throw error;
    }
  }
  if (!row || row.kind !== 'dcr') throw new OAuthFailure('invalid_client', 'unknown client');
  return fromRow(row);
}

/** Token/revocation endpoint client authentication. */
export async function authenticateClient(
  db: Db,
  settings: Settings,
  input: { basic: { id: string; secret: string } | null; clientId?: string; clientSecret?: string },
  fetchImpl: typeof fetch,
): Promise<OAuthClient> {
  const clientId = input.basic?.id ?? input.clientId;
  if (!clientId) throw new OAuthFailure('invalid_client', 'client authentication required', 401);
  if (input.basic && input.clientId && input.clientId !== input.basic.id) {
    throw new OAuthFailure('invalid_request', 'client_id does not match the Authorization header');
  }
  let client: OAuthClient;
  try {
    client = await findClient(db, settings, clientId, fetchImpl);
  } catch (error) {
    if (error instanceof OAuthFailure) throw new OAuthFailure('invalid_client', error.description, 401);
    throw error;
  }
  if (client.authMethod === 'none') return client;
  const secret = input.basic?.secret ?? input.clientSecret;
  if (!secret || !client.secretHash || !safeEqual(sha256(secret), client.secretHash)) {
    throw new OAuthFailure('invalid_client', 'client authentication failed', 401);
  }
  return client;
}

export function purgeClients(db: Db): void {
  const now = Date.now();
  // Registered but never authorized within a week, or no live authorization for 30 days.
  run(
    db,
    `DELETE FROM oauth_clients WHERE kind = 'dcr' AND (
        (created_at < :week AND client_id NOT IN (SELECT client_id FROM oauth_grants))
     OR (created_at < :month AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL)))`,
    {
      week: new Date(now - 7 * 24 * 3600 * 1000).toISOString(),
      month: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
    },
  );
  run(db, "DELETE FROM oauth_clients WHERE kind = 'cimd' AND expires_at < :old", {
    old: new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
  });
  for (const [clientId, until] of cimdFailures) if (until <= now) cimdFailures.delete(clientId);
}
