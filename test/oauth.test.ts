import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, type TestContext as NodeTest } from 'node:test';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { readAppCookie, setAppCookie } from '../src/auth/cookies.ts';
import type { IdentityProvider } from '../src/auth/oidc.ts';
import { CONTROL_COOKIE, CONTROL_SCOPE, resolveSession, SESSION_TTL_MS } from '../src/auth/sessions.ts';
import { get, run } from '../src/db/database.ts';
import { safeNextPath } from '../src/lib/http.ts';
import { CONTROL_CSP, securityHeaders } from '../src/lib/security.ts';
import { purgeClients } from '../src/oauth/clients.ts';
import { loadOAuthConfig, type OAuthDeps } from '../src/oauth/config.ts';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from '../src/oauth/metadata.ts';
import { oauthRoutes, type ResourceResolver } from '../src/oauth/routes.ts';
import { listGrants, purgeOAuth, revokeGrant, verifyAccessToken, verifyAccessTokenFor } from '../src/oauth/tokens.ts';
import { allowlist, type ControlEnv } from '../src/types.ts';
import { ALICE, BOB, Browser, CONTROL, DEMO, NOTES, setup, signIn, type TestContext } from './helpers.ts';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

// The protected resources of the platform under test: the builder on the control plane,
// and one MCP endpoint per app. Only Alice may use the one of the second app.
const BUILDER = `${CONTROL}/mcp`;
const DEMO_MCP = `${DEMO}/_socle/mcp`;
const NOTES_MCP = `${NOTES}/_socle/mcp`;

/** Resources a test takes away from everyone while a request is in progress. */
const closed = new Set<string>();

const resolver: ResourceResolver = (resource, user) => {
  if (closed.has(resource)) return null;
  if (resource === BUILDER) return { name: 'App builder', description: 'Creates <apps> & changes them.' };
  if (resource === DEMO_MCP) return { name: 'Demo', description: 'The demo app.' };
  if (resource === NOTES_MCP && user.email === ALICE) return { name: 'Notes', description: '' };
  return null;
};

interface Platform {
  ctx: TestContext;
  deps: OAuthDeps;
  /** The control plane as far as this module needs it: its headers, its session, and the OAuth routes. */
  app: Hono;
  isAllowed: (email: string) => boolean;
}

function start(t: NodeTest, options: { fetch?: typeof fetch; identity?: IdentityProvider } = {}): Platform {
  const ctx = setup({ identity: options.identity });
  t.after(() => ctx.cleanup());
  // Shares the allowlist set with ctx.deps.config: removing an address is seen by both.
  const config = { ...ctx.deps.config, oauth: loadOAuthConfig({}) };
  const deps: OAuthDeps = { ...ctx.deps, config, fetch: options.fetch };
  const isAllowed = allowlist(config);
  const app = new Hono<ControlEnv>();
  app.use('*', securityHeaders(config, CONTROL_CSP));
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Request too large', 413) }));
  // The session middleware of src/control/app.ts.
  app.use('*', async (c, next) => {
    const token = readAppCookie(c, config, CONTROL_COOKIE);
    const session = token ? resolveSession(deps.db, token, CONTROL_SCOPE, isAllowed) : null;
    if (token && session?.renewed) setAppCookie(c, config, CONTROL_COOKIE, token, SESSION_TTL_MS / 1000);
    c.set('session', session);
    await next();
  });
  app.route('/', oauthRoutes(deps, resolver));
  return { ctx, deps, app: app as unknown as Hono, isAllowed };
}

/** A browser on the platform, signed in as `email` on the control plane when one is given. */
function browserOf(p: Platform, email?: string): Browser {
  const browser = new Browser(p.app);
  if (email) signIn(p.ctx, browser, email);
  return browser;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** What a browser sends when a tab navigates to a page. */
const NAVIGATION = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

const unescapeHtml = (text: string) =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

async function register(p: Platform, body: Record<string, unknown>, ip = '198.51.100.1') {
  return p.app.request(`${CONTROL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

async function registered(p: Platform, body: Record<string, unknown>): Promise<Record<string, string>> {
  const response = await register(p, body);
  assert.equal(response.status, 201);
  return (await response.json()) as Record<string, string>;
}

function authorizeUrl(params: Record<string, string>): string {
  return `${CONTROL}/oauth/authorize?${new URLSearchParams(params)}`;
}

/** The first step: the authorization request, as the tab the client opened. */
function begin(browser: Browser, params: Record<string, string>, headers: Record<string, string> = {}) {
  return browser.request(authorizeUrl(params), { headers: { ...NAVIGATION, ...headers } });
}

/** Sends the consent form the way the consent page does (same origin), unless told otherwise. */
function answer(
  browser: Browser,
  form: Record<string, string>,
  headers: Record<string, string> = { origin: CONTROL, 'sec-fetch-site': 'same-origin' },
) {
  return browser.request(`${CONTROL}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

/** Where the page that follows an answer takes the browser. */
async function handedOverTo(response: Response): Promise<URL> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const link = /<a class="button primary" href="([^"]+)"/.exec(html);
  const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)"/.exec(html);
  assert.ok(link && refresh, 'the page names where it goes');
  assert.equal(refresh[1], link[1]);
  assert.doesNotMatch(html, /<script/i);
  return new URL(unescapeHtml(link[1]!));
}

/** Opens the consent page of a signed-in browser; returns the page and the request it names. */
async function consent(browser: Browser, params: Record<string, string>) {
  const first = await begin(browser, params);
  assert.equal(first.status, 302);
  const location = first.headers.get('location')!;
  assert.match(location, /^\/oauth\/authorize\?request=[\w-]{32}$/);
  const page = await browser.request(CONTROL + location, { headers: NAVIGATION });
  assert.equal(page.status, 200);
  const html = await page.text();
  const requestId = /name="request" value="([\w-]{32})"/.exec(html)?.[1];
  assert.ok(requestId);
  return { html, requestId, page };
}

/** The whole way for a signed-in member: request, consent page, answer. Returns where the browser is sent. */
async function authorize(
  browser: Browser,
  params: Record<string, string>,
  decision: 'allow' | 'deny' = 'allow',
): Promise<URL> {
  const { requestId } = await consent(browser, params);
  return handedOverTo(await answer(browser, { request: requestId, decision }));
}

async function token(p: Platform, body: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await p.app.request(`${CONTROL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, json: (await response.json()) as Record<string, string> };
}

/** A public client and tokens for `resource`, authorized by `email`. */
async function connected(p: Platform, email: string, resource: string) {
  const client = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
  const { verifier, challenge } = pkce();
  const back = await authorize(browserOf(p, email), {
    response_type: 'code',
    client_id: client.client_id!,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  });
  const issued = await token(p, {
    grant_type: 'authorization_code',
    client_id: client.client_id!,
    code: back.searchParams.get('code')!,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  assert.equal(issued.status, 200);
  return { clientId: client.client_id!, tokens: issued.json };
}

const count = (p: Platform, table: string, where = '1') =>
  get<{ n: number }>(p.deps.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)!.n;

describe('OAuth authorization server for MCP clients', () => {
  it('publishes RFC 8414 metadata, and describes each protected resource (RFC 9728)', async (t) => {
    const p = start(t);
    const response = await p.app.request(`${CONTROL}/.well-known/oauth-authorization-server`);
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(metadata, authorizationServerMetadata(p.deps.config));
    assert.equal(metadata.issuer, CONTROL);
    assert.equal(metadata.authorization_endpoint, `${CONTROL}/oauth/authorize`);
    assert.equal(metadata.token_endpoint, `${CONTROL}/oauth/token`);
    assert.equal(metadata.registration_endpoint, `${CONTROL}/oauth/register`);
    assert.equal(metadata.revocation_endpoint, `${CONTROL}/oauth/revoke`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.scopes_supported, ['socle']);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);

    assert.deepEqual(protectedResourceMetadata(p.deps.config, DEMO_MCP, 'Demo'), {
      resource: DEMO_MCP,
      authorization_servers: [CONTROL],
      scopes_supported: ['socle'],
      bearer_methods_supported: ['header'],
      resource_name: 'Demo',
    });
    // The well-known segment goes in front of the resource's path, on the resource's own origin.
    assert.equal(protectedResourceMetadataUrl(BUILDER), `${CONTROL}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(protectedResourceMetadataUrl(DEMO_MCP), `${DEMO}/.well-known/oauth-protected-resource/_socle/mcp`);
    assert.equal(protectedResourceMetadataUrl(`${DEMO}/`), `${DEMO}/.well-known/oauth-protected-resource`);
    assert.equal(
      protectedResourceMetadataUrl('http://localhost:8787/mcp?x=1'),
      'http://localhost:8787/.well-known/oauth-protected-resource/mcp?x=1',
    );
  });

  it('lets clients running in a browser read the metadata and reach the token endpoints, not register', async (t) => {
    const p = start(t);
    const preflight = (path: string) =>
      p.app.request(CONTROL + path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://inspector.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    for (const path of ['/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server']) {
      const response = await preflight(path);
      assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
      assert.equal(response.headers.get('access-control-allow-credentials'), null, path);
    }
    for (const path of ['/oauth/register', '/oauth/authorize']) {
      assert.equal((await preflight(path)).headers.get('access-control-allow-origin'), null, path);
    }
  });

  it('only registers clients that redirect to an allowed callback or to loopback', async (t) => {
    const p = start(t);
    const evil = await register(p, {
      redirect_uris: ['https://evil.example/callback'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(evil.status, 400);
    assert.equal(((await evil.json()) as { error: string }).error, 'invalid_redirect_uri');
    assert.equal((await register(p, { redirect_uris: ['cursor://callback'] })).status, 400);
    assert.equal((await register(p, { redirect_uris: ['http://claude.ai/callback'] })).status, 400);
    assert.equal((await register(p, { redirect_uris: [`${CALLBACK}#fragment`] })).status, 400);
    assert.equal((await register(p, { redirect_uris: [] })).status, 400);
    assert.equal(
      (await register(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'private_key_jwt' })).status,
      400,
    );
    assert.equal(count(p, 'oauth_clients'), 0);

    const ok = await register(p, { redirect_uris: [CALLBACK], client_name: 'Claude' });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = (await ok.json()) as Record<string, unknown>;
    assert.match(String(body.client_id), /^socle_client_/);
    assert.equal(body.scope, 'socle');
    // RFC 7591 default auth method is client_secret_basic → a secret is issued, and only its hash is kept.
    assert.equal(typeof body.client_secret, 'string');
    const stored = get<{ client_secret_hash: string; registration: string }>(
      p.deps.db,
      'SELECT client_secret_hash, registration FROM oauth_clients WHERE client_id = :id',
      { id: String(body.client_id) },
    )!;
    assert.notEqual(stored.client_secret_hash, body.client_secret);
    assert.ok(!stored.registration.includes(String(body.client_secret)));

    const local = await register(p, {
      redirect_uris: ['http://localhost:33418/callback'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(local.status, 201);
    assert.ok(!('client_secret' in ((await local.json()) as Record<string, unknown>)));
  });

  it('runs the full authorization-code flow with PKCE, and kills what a replayed code produced', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], client_name: 'Claude <b>' });
    const basic = `Basic ${Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString('base64')}`;
    const browser = browserOf(p, BOB);
    const { verifier, challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: BUILDER,
      scope: 'socle',
    };

    // The consent page says who asks, for what, as whom, and where the answer goes. No script.
    const { html, requestId, page } = await consent(browser, params);
    assert.match(html, /Claude &lt;b&gt; wants to use App builder/);
    assert.match(html, /Creates &lt;apps&gt; &amp; changes them\./);
    assert.match(html, new RegExp(`signed in as ${BOB}`));
    assert.match(html, /nothing verifies it/);
    assert.match(html, /Your answer is sent to claude\.ai\./);
    assert.doesNotMatch(html, /<script/i);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('content-security-policy'), CONTROL_CSP);
    // Reloading the page does not ask for anything new.
    assert.equal(count(p, 'oauth_requests'), 1);

    const back = await handedOverTo(await answer(browser, { request: requestId, decision: 'allow' }));
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), CONTROL);
    const code = back.searchParams.get('code')!;
    assert.match(code, /^socle_code_/);
    // The answer was given once: the same form cannot be sent again.
    assert.equal((await answer(browser, { request: requestId, decision: 'allow' })).status, 400);
    assert.equal(count(p, 'oauth_requests'), 0);
    // Codes are stored as hashes.
    assert.equal(count(p, 'oauth_codes', `code_hash = '${code}'`), 0);

    // Wrong verifier and wrong client secret are refused.
    const wrongVerifier = await token(
      p,
      { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: pkce().verifier },
      { authorization: basic },
    );
    assert.equal(wrongVerifier.json.error, 'invalid_grant');
    const badSecret = await token(
      p,
      { grant_type: 'authorization_code', code, code_verifier: verifier },
      { authorization: `Basic ${Buffer.from(`${reg.client_id}:nope`).toString('base64')}` },
    );
    assert.equal(badSecret.status, 401);
    // The redirect URI given at /authorize has to come back identical.
    const noRedirect = await token(
      p,
      { grant_type: 'authorization_code', code, code_verifier: verifier },
      { authorization: basic },
    );
    assert.equal(noRedirect.json.error, 'invalid_request');

    // None of the failed attempts above burned the code.
    const ok = await token(
      p,
      { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier, resource: BUILDER },
      { authorization: basic },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.token_type, 'Bearer');
    assert.equal(ok.json.scope, 'socle');
    assert.match(ok.json.access_token!, /^socle_at_/);
    assert.match(ok.json.refresh_token!, /^socle_rt_/);
    const access = verifyAccessToken(p.deps.db, ok.json.access_token!, p.isAllowed);
    assert.equal(access?.email, BOB);
    assert.equal(access?.resource, BUILDER);
    assert.equal(access?.clientName, 'Claude <b>');
    assert.deepEqual(access?.scopes, ['socle']);
    assert.equal(count(p, 'oauth_tokens', `token_hash IN ('${ok.json.access_token}', '${ok.json.refresh_token}')`), 0);

    // Replaying the code fails and kills the tokens it produced.
    const replay = await token(
      p,
      { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier },
      { authorization: basic },
    );
    assert.equal(replay.json.error, 'invalid_grant');
    assert.equal(verifyAccessToken(p.deps.db, ok.json.access_token!, p.isAllowed), null);
    const afterReplay = await token(
      p,
      { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token! },
      { authorization: basic },
    );
    assert.equal(afterReplay.json.error, 'invalid_grant');
  });

  it('rotates refresh tokens and revokes the grant on late reuse', async (t) => {
    const p = start(t);
    const reg = await registered(p, {
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    });
    const browser = browserOf(p, BOB);
    const { verifier, challenge } = pkce();
    // Loopback redirect: any port is accepted at request time (RFC 8252).
    const redirect = 'http://127.0.0.1:51234/callback';
    const params = {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    };
    const { html, requestId } = await consent(browser, params);
    // A client on the member's machine, without a name: the page says so and warns.
    assert.match(html, /An application wants to use App builder/);
    assert.match(html, /did not give its name/);
    assert.match(html, /an application on this device \(127\.0\.0\.1:51234\)/);
    assert.match(html, /Only allow this if you have just started the connection yourself/);
    const back = await handedOverTo(await answer(browser, { request: requestId, decision: 'allow' }));
    assert.equal(back.host, '127.0.0.1:51234');
    const first = await token(p, {
      grant_type: 'authorization_code',
      client_id: reg.client_id!,
      code: back.searchParams.get('code')!,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    assert.equal(first.status, 200);

    const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
      token(p, { grant_type: 'refresh_token', client_id: reg.client_id!, refresh_token: refreshToken, ...extra });
    assert.equal((await refresh(first.json.refresh_token!, { scope: 'socle admin' })).json.error, 'invalid_scope');
    const second = await refresh(first.json.refresh_token!);
    assert.equal(second.status, 200);
    assert.notEqual(second.json.refresh_token, first.json.refresh_token);
    assert.notEqual(second.json.access_token, first.json.access_token);
    // Immediate reuse (retry/concurrency) is tolerated, and answers with the same successor…
    const retry = await refresh(first.json.refresh_token!);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.refresh_token, second.json.refresh_token);
    // …but a reuse after the grace period revokes everything.
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      assert.equal((await refresh(first.json.refresh_token!)).json.error, 'invalid_grant');
      assert.equal((await refresh(second.json.refresh_token!)).json.error, 'invalid_grant');
      assert.equal(verifyAccessToken(p.deps.db, second.json.access_token!, p.isAllowed), null);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses bad authorization requests without redirecting to unknown URIs', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const browser = browserOf(p, BOB);
    const base = {
      response_type: 'code',
      client_id: reg.client_id!,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    };
    // Unregistered redirect URI → error page, no redirect.
    const wrongRedirect = await begin(browser, { ...base, redirect_uri: 'https://claude.ai/elsewhere' });
    assert.equal(wrongRedirect.status, 400);
    assert.equal(wrongRedirect.headers.get('location'), null);
    // Unknown client → error page.
    assert.equal((await begin(browser, { ...base, client_id: 'socle_client_nope' })).status, 400);
    const { client_id: _, ...withoutClient } = base;
    assert.equal((await begin(browser, withoutClient)).status, 400);

    // From here the client is known: errors go back to it, with the issuer and its state.
    const errorOf = async (params: Record<string, string>, as = browser) => {
      const response = await begin(as, { ...params, state: 's1' });
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.origin + location.pathname, CALLBACK);
      assert.equal(location.searchParams.get('iss'), CONTROL);
      assert.equal(location.searchParams.get('state'), 's1');
      return location.searchParams.get('error');
    };
    assert.equal(await errorOf({ ...base, response_type: 'token' }), 'unsupported_response_type');
    assert.equal(await errorOf({ ...base, code_challenge_method: 'plain' }), 'invalid_request');
    assert.equal(await errorOf({ ...base, code_challenge: 'short' }), 'invalid_request');
    // These are refused before sign-in too: nothing about them depends on who asks.
    assert.equal(await errorOf({ ...base, code_challenge_method: 'plain' }, browserOf(p)), 'invalid_request');

    // The resource is required, and has to be one this member may use.
    const { resource: __, ...withoutResource } = base;
    assert.equal(await errorOf(withoutResource), 'invalid_target');
    assert.equal(await errorOf(withoutResource, browserOf(p)), 'invalid_target');
    assert.equal(await errorOf({ ...base, resource: 'not a uri' }), 'invalid_target');
    assert.equal(await errorOf({ ...base, resource: `${BUILDER}#fragment` }), 'invalid_target');
    assert.equal(await errorOf({ ...base, resource: 'https://other.example/mcp' }), 'invalid_target');
    assert.equal(await errorOf({ ...base, resource: CONTROL }), 'invalid_target'); // the bare origin is not the endpoint
    assert.equal(await errorOf({ ...base, resource: NOTES_MCP }), 'invalid_target'); // Bob may not use that app
    const alice = await begin(browserOf(p, ALICE), { ...base, resource: NOTES_MCP });
    assert.match(alice.headers.get('location')!, /^\/oauth\/authorize\?request=/);
    // Only the request that was accepted left a row.
    assert.equal(count(p, 'oauth_requests'), 1);
    assert.equal(count(p, 'oauth_codes'), 0);

    // The request page is a page: nothing a sibling origin loads in the background starts one.
    const background = await begin(browser, base, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });
    assert.equal(background.status, 400);
    const framed = await begin(browser, base, { 'sec-fetch-dest': 'iframe' });
    assert.equal(framed.status, 400);
    assert.equal(count(p, 'oauth_requests'), 1);
  });

  it('signs an anonymous visitor in first, then comes back to the same request, storing nothing', async (t) => {
    let asked: string | undefined;
    const identity: IdentityProvider = {
      start: async (nextPath) => {
        asked = nextPath;
        return { url: 'https://accounts.example.com/authorize', pending: 'pending' };
      },
      finish: () => Promise.reject(new Error('not used')),
    };
    const p = start(t, { identity });
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
      state: 'a state with spaces, a \\ and an é',
      utm_source: 'dropped: not a parameter of this server',
    };
    const browser = browserOf(p);
    const anonymous = await begin(browser, params);
    assert.equal(anonymous.status, 302);
    const toSignIn = anonymous.headers.get('location')!;
    assert.match(toSignIn, /^\/auth\/start\?next=%2Foauth%2Fauthorize%3F/);
    assert.equal(count(p, 'oauth_requests'), 0);
    const next = new URL(toSignIn, CONTROL).searchParams.get('next')!;
    assert.ok(!next.includes('utm_source'));
    // The control plane accepts it as it is…
    assert.equal(safeNextPath(next, 1500), next);
    assert.equal((await p.ctx.app.request(CONTROL + toSignIn)).status, 302);
    assert.equal(asked, next);

    // …and once signed in, the same address leads to the consent page and to a code.
    signIn(p.ctx, browser, BOB);
    const again = await browser.request(CONTROL + next, { headers: NAVIGATION });
    assert.equal(again.status, 302);
    const page = await browser.request(CONTROL + again.headers.get('location')!, { headers: NAVIGATION });
    const requestId = /name="request" value="([\w-]{32})"/.exec(await page.text())![1]!;
    const back = await handedOverTo(await answer(browser, { request: requestId, decision: 'allow' }));
    assert.equal(back.searchParams.get('state'), params.state);
    const issued = await token(p, {
      grant_type: 'authorization_code',
      client_id: reg.client_id!,
      code: back.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.equal(issued.status, 200);
  });

  it('parks a request too long to travel through sign-in, in bounded number, without locking members out', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = pkce();
    const long = {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
      state: 'x'.repeat(1600),
    };
    const browser = browserOf(p);
    const parked = await begin(browser, long);
    assert.equal(parked.status, 302);
    const next = new URL(parked.headers.get('location')!, CONTROL).searchParams.get('next')!;
    assert.match(next, /^\/oauth\/authorize\?request=[\w-]{32}$/);
    assert.equal(safeNextPath(next, 1500), next);
    assert.equal(count(p, 'oauth_requests', 'session_hash IS NULL'), 1);
    const requestId = next.split('=')[1]!;
    // Its id is stored as a hash.
    assert.equal(count(p, 'oauth_requests', `id_hash = '${requestId}'`), 0);

    // Still anonymous: back to sign-in. And an answer never opens a parked request by itself:
    // it only counts for a request this session was shown.
    const stillAnonymous = await browser.request(CONTROL + next, { headers: NAVIGATION });
    assert.match(stillAnonymous.headers.get('location')!, /^\/auth\/start\?next=/);
    signIn(p.ctx, browser, BOB);
    assert.equal((await answer(browser, { request: requestId, decision: 'allow' })).status, 400);
    assert.equal(count(p, 'oauth_codes'), 0);

    const page = await browser.request(CONTROL + next, { headers: NAVIGATION });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /wants to use App builder/);
    const back = await handedOverTo(await answer(browser, { request: requestId, decision: 'allow' }));
    assert.equal(back.searchParams.get('state'), long.state);
    const issued = await token(p, {
      grant_type: 'authorization_code',
      client_id: reg.client_id!,
      code: back.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.equal(issued.status, 200);

    // A parked request for a resource the member may not use is refused once we know who asks.
    const refused = await begin(browserOf(p), { ...long, resource: NOTES_MCP });
    const refusedNext = new URL(refused.headers.get('location')!, CONTROL).searchParams.get('next')!;
    const bob = browserOf(p, BOB);
    const answerToClient = await bob.request(CONTROL + refusedNext, { headers: NAVIGATION });
    assert.equal(answerToClient.status, 302);
    const location = new URL(answerToClient.headers.get('location')!);
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get('error'), 'invalid_target');
    assert.equal(location.searchParams.get('state'), long.state);
    assert.equal(count(p, 'oauth_requests'), 0);

    // Thousands of abandoned long requests from many addresses fill the parking…
    let last = 0;
    for (let i = 0; i < 5001; i++) {
      const flood = await begin(browserOf(p), long, { 'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250}` });
      last = flood.status;
      if (i < 5000) assert.equal(flood.status, 302);
    }
    assert.equal(last, 429);
    assert.equal(count(p, 'oauth_requests', 'session_hash IS NULL'), 5000);
    // …and a member still connects a client, with a long request or a short one.
    const member = browserOf(p, ALICE);
    for (const state of ['short', long.state]) {
      const fresh = pkce();
      const again = await authorize(member, { ...long, code_challenge: fresh.challenge, state });
      assert.match(again.searchParams.get('code')!, /^socle_code_/);
    }
    // One browser session only keeps its latest requests.
    for (let i = 0; i < 25; i++) assert.equal((await begin(member, { ...long, state: `s${i}` })).status, 302);
    assert.equal(count(p, 'oauth_requests', 'session_hash IS NOT NULL'), 10);
    // The parked ones expire.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      assert.equal((await begin(browserOf(p), long)).status, 302);
      assert.equal(count(p, 'oauth_requests', 'session_hash IS NULL'), 1);
    } finally {
      Date.now = realNow;
    }
  });

  it('only takes the answer from the consent page itself, in the session that was shown it', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const bob = browserOf(p, BOB);
    const { requestId } = await consent(bob, {
      response_type: 'code',
      client_id: reg.client_id!,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    });
    const form = { request: requestId, decision: 'allow' };
    // No Origin, a foreign origin, a sibling app, or the right origin claimed from another site.
    assert.equal((await answer(bob, form, {})).status, 403);
    assert.equal((await answer(bob, form, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await answer(bob, form, { origin: DEMO, 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await answer(bob, form, { origin: CONTROL, 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await answer(bob, form, { origin: CONTROL, 'sec-fetch-site': 'cross-site' })).status, 403);
    // A GET never decides.
    const viaGet = await bob.request(`${CONTROL}/oauth/authorize?request=${requestId}&decision=allow`, {
      headers: NAVIGATION,
    });
    assert.equal(viaGet.status, 200);
    assert.equal(count(p, 'oauth_codes'), 0);

    // Another member cannot complete, or even see, a request opened in Bob's session.
    const alice = browserOf(p, ALICE);
    assert.equal((await answer(alice, form)).status, 400);
    const peek = await alice.request(`${CONTROL}/oauth/authorize?request=${requestId}`, { headers: NAVIGATION });
    assert.equal(peek.status, 400);
    // Nor a visitor without a session.
    assert.equal((await answer(browserOf(p), form)).status, 401);
    assert.equal((await answer(bob, { request: 'x'.repeat(32), decision: 'allow' })).status, 400);
    assert.equal(count(p, 'oauth_codes'), 0);

    // None of this consumed the request: Bob can still answer. Deny sends access_denied back.
    const denied = await handedOverTo(await answer(bob, { request: requestId, decision: 'deny' }));
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('iss'), CONTROL);
    assert.equal(denied.searchParams.get('code'), null);
    assert.equal(count(p, 'oauth_codes'), 0);
  });

  it('asks again whether the member may use the resource when the answer arrives', async (t) => {
    const p = start(t);
    t.after(() => closed.clear());
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const alice = browserOf(p, ALICE);
    const params = {
      response_type: 'code',
      client_id: reg.client_id!,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: NOTES_MCP,
      state: 's2',
    };
    const { html, requestId } = await consent(alice, params);
    assert.match(html, /wants to use Notes/);
    // Between the page and the answer, the app is taken away from her.
    closed.add(NOTES_MCP);
    const back = await handedOverTo(await answer(alice, { request: requestId, decision: 'allow' }));
    assert.equal(back.searchParams.get('error'), 'invalid_target');
    assert.equal(back.searchParams.get('state'), 's2');
    assert.equal(back.searchParams.get('code'), null);
    assert.equal(count(p, 'oauth_codes'), 0);
    // And a page that was not shown yet answers the client instead of asking her.
    closed.clear();
    const first = await begin(alice, params);
    closed.add(NOTES_MCP);
    const refused = await alice.request(CONTROL + first.headers.get('location')!, { headers: NAVIGATION });
    assert.equal(refused.status, 302);
    assert.equal(new URL(refused.headers.get('location')!).searchParams.get('error'), 'invalid_target');
    assert.equal(count(p, 'oauth_requests'), 0);
  });

  it('binds the grant, the code and the tokens to one resource', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = pkce();
    const back = await authorize(browserOf(p, BOB), {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: DEMO_MCP,
    });
    const exchange = (resource?: string) =>
      token(p, {
        grant_type: 'authorization_code',
        client_id: reg.client_id!,
        code: back.searchParams.get('code')!,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        ...(resource === undefined ? {} : { resource }),
      });
    // The code was issued for the demo app's endpoint: it cannot be turned into tokens for another one.
    assert.equal((await exchange(BUILDER)).json.error, 'invalid_target');
    assert.equal((await exchange(DEMO)).json.error, 'invalid_target');
    const issued = await exchange(DEMO_MCP);
    assert.equal(issued.status, 200);
    const accessToken = issued.json.access_token!;

    // The token says which resource it is for, and is refused everywhere else.
    assert.equal(verifyAccessToken(p.deps.db, accessToken, p.isAllowed)?.resource, DEMO_MCP);
    assert.equal(verifyAccessTokenFor(p.deps.db, accessToken, p.isAllowed, DEMO_MCP)?.email, BOB);
    assert.equal(verifyAccessTokenFor(p.deps.db, accessToken, p.isAllowed, BUILDER), null);
    assert.equal(verifyAccessTokenFor(p.deps.db, accessToken, p.isAllowed, NOTES_MCP), null);
    assert.equal(verifyAccessTokenFor(p.deps.db, accessToken, p.isAllowed, `${DEMO_MCP}/`), null);
    assert.equal(verifyAccessTokenFor(p.deps.db, `${accessToken}x`, p.isAllowed, DEMO_MCP), null);
    // A refresh token is not an access token.
    assert.equal(verifyAccessTokenFor(p.deps.db, issued.json.refresh_token!, p.isAllowed, DEMO_MCP), null);

    // Refreshing keeps the resource, and cannot move to another one.
    const refresh = (resource?: string) =>
      token(p, {
        grant_type: 'refresh_token',
        client_id: reg.client_id!,
        refresh_token: issued.json.refresh_token!,
        ...(resource === undefined ? {} : { resource }),
      });
    assert.equal((await refresh(BUILDER)).json.error, 'invalid_target');
    const refreshed = await refresh(DEMO_MCP);
    assert.equal(refreshed.status, 200);
    assert.equal(verifyAccessTokenFor(p.deps.db, refreshed.json.access_token!, p.isAllowed, BUILDER), null);
    assert.equal(verifyAccessTokenFor(p.deps.db, refreshed.json.access_token!, p.isAllowed, DEMO_MCP)?.email, BOB);

    // Tokens of another client's grant: one client cannot refresh or revoke them.
    const other = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const stolen = await token(p, {
      grant_type: 'refresh_token',
      client_id: other.client_id!,
      refresh_token: refreshed.json.refresh_token!,
    });
    assert.equal(stolen.json.error, 'invalid_grant');
    assert.equal(verifyAccessTokenFor(p.deps.db, refreshed.json.access_token!, p.isAllowed, DEMO_MCP)?.email, BOB);
  });

  it('accepts Client ID Metadata Documents only from trusted hosts', async (t) => {
    const docUrl = 'https://claude.ai/oauth/mcp-client.json';
    const fetched: string[] = [];
    const p = start(t, {
      fetch: async (input) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return Response.json(
          {
            client_id: docUrl,
            client_name: 'Claude',
            // Whatever else the document lists, only the allowed callbacks are kept.
            redirect_uris: [CALLBACK, 'https://evil.example/callback'],
            token_endpoint_auth_method: 'none',
          },
          { headers: { 'cache-control': 'max-age=600' } },
        );
      },
    });
    const browser = browserOf(p, BOB);
    const { verifier, challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: docUrl,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    };
    const { html, requestId } = await consent(browser, params);
    assert.match(html, /Claude wants to use App builder/);
    assert.match(html, /The identity of this application is published by claude\.ai\./);
    const back = await handedOverTo(await answer(browser, { request: requestId, decision: 'allow' }));
    const ok = await token(p, {
      grant_type: 'authorization_code',
      client_id: docUrl,
      code: back.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(fetched, [docUrl]); // cached afterwards

    const elsewhere = await begin(browser, { ...params, redirect_uri: 'https://evil.example/callback' });
    assert.equal(elsewhere.status, 400);
    const untrusted = await begin(browser, { ...params, client_id: 'https://evil.example/client.json' });
    assert.equal(untrusted.status, 400);
    const lookalike = await begin(browser, { ...params, client_id: 'https://claude.ai.evil.example/client.json' });
    assert.equal(lookalike.status, 400);
    assert.equal(fetched.length, 1); // never fetched
  });

  it('stops honouring tokens when the member leaves the allowlist', async (t) => {
    const p = start(t);
    const { clientId, tokens } = await connected(p, BOB, BUILDER);
    assert.equal(verifyAccessTokenFor(p.deps.db, tokens.access_token!, p.isAllowed, BUILDER)?.email, BOB);

    (p.deps.config.allowedEmails as Set<string>).delete(BOB);
    assert.equal(verifyAccessTokenFor(p.deps.db, tokens.access_token!, p.isAllowed, BUILDER), null);
    assert.equal(verifyAccessToken(p.deps.db, tokens.access_token!, p.isAllowed), null);
    const refreshed = await token(p, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token!,
    });
    assert.equal(refreshed.json.error, 'invalid_grant');

    // Coming back on the list does not bring the grant back: the refusal above ended it.
    (p.deps.config.allowedEmails as Set<string>).add(BOB);
    assert.equal(verifyAccessToken(p.deps.db, tokens.access_token!, p.isAllowed), null);
  });

  it('refuses to turn a code into tokens for a member who left the allowlist meanwhile', async (t) => {
    const p = start(t);
    const reg = await registered(p, { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' });
    const { verifier, challenge } = pkce();
    const back = await authorize(browserOf(p, BOB), {
      response_type: 'code',
      client_id: reg.client_id!,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    });
    (p.deps.config.allowedEmails as Set<string>).delete(BOB);
    const refused = await token(p, {
      grant_type: 'authorization_code',
      client_id: reg.client_id!,
      code: back.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.equal(refused.json.error, 'invalid_grant');
    assert.equal(count(p, 'oauth_tokens'), 0);
  });

  it('ends a grant when its client revokes a token, or when the member disconnects it', async (t) => {
    const p = start(t);
    const first = await connected(p, BOB, BUILDER);
    const second = await connected(p, BOB, DEMO_MCP);
    const bob = get<{ id: number }>(p.deps.db, 'SELECT id FROM users WHERE email = :email', { email: BOB })!.id;
    assert.deepEqual(
      listGrants(p.deps.db, bob)
        .map((grant) => grant.resource)
        .sort(),
      [DEMO_MCP, BUILDER].sort(),
    );

    const revoke = (clientId: string, value: string) =>
      p.app.request(`${CONTROL}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, token: value }).toString(),
      });
    // Another client's token: answered like any revocation (RFC 7009), but nothing ends.
    assert.equal((await revoke(second.clientId, first.tokens.refresh_token!)).status, 200);
    assert.equal(verifyAccessTokenFor(p.deps.db, first.tokens.access_token!, p.isAllowed, BUILDER)?.email, BOB);
    assert.equal((await revoke(first.clientId, first.tokens.refresh_token!)).status, 200);
    assert.equal(verifyAccessTokenFor(p.deps.db, first.tokens.access_token!, p.isAllowed, BUILDER), null);
    assert.equal(verifyAccessTokenFor(p.deps.db, second.tokens.access_token!, p.isAllowed, DEMO_MCP)?.email, BOB);

    // The member's own list: only their grants, and revoking one ends its tokens.
    const [remaining] = listGrants(p.deps.db, bob);
    assert.equal(listGrants(p.deps.db, bob).length, 1);
    assert.equal(revokeGrant(p.deps.db, remaining!.id, bob + 1), false);
    assert.equal(revokeGrant(p.deps.db, remaining!.id, bob), true);
    assert.equal(verifyAccessTokenFor(p.deps.db, second.tokens.access_token!, p.isAllowed, DEMO_MCP), null);
    assert.equal(count(p, 'oauth_tokens'), 0);
  });

  it('keeps the number of registered clients bounded, without dropping one a member authorized', async (t) => {
    const p = start(t);
    const { clientId, tokens } = await connected(p, BOB, BUILDER);
    let first: string | undefined;
    for (let i = 0; i < 520; i++) {
      const response = await register(
        p,
        { redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' },
        `203.0.113.${i % 250}`,
      );
      assert.equal(response.status, 201);
      first ??= ((await response.json()) as { client_id: string }).client_id;
    }
    assert.equal(count(p, 'oauth_clients'), 500);
    assert.equal(count(p, 'oauth_clients', `client_id = '${clientId}'`), 1);
    assert.equal(count(p, 'oauth_clients', `client_id = '${first}'`), 0); // the oldest unused ones made room
    assert.equal(verifyAccessTokenFor(p.deps.db, tokens.access_token!, p.isAllowed, BUILDER)?.email, BOB);
    // One address cannot register without end.
    let status = 201;
    for (let i = 0; i < 21 && status === 201; i++) {
      status = (await register(p, { redirect_uris: ['http://localhost/callback'] }, '192.0.2.7')).status;
    }
    assert.equal(status, 429);
  });

  it('cleans up what expired: requests, codes, tokens, dead grants and unused clients', async (t) => {
    const p = start(t);
    const { clientId, tokens } = await connected(p, BOB, BUILDER);
    await registered(p, { redirect_uris: [CALLBACK] }); // never authorized
    await begin(browserOf(p, BOB), {
      response_type: 'code',
      client_id: clientId,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: BUILDER,
    });
    assert.equal(count(p, 'oauth_requests'), 1);

    // Nothing live is touched.
    purgeOAuth(p.deps.db);
    purgeClients(p.deps.db);
    assert.equal(count(p, 'oauth_requests'), 1);
    assert.equal(count(p, 'oauth_clients'), 2);
    assert.equal(count(p, 'oauth_codes'), 1);
    assert.equal(verifyAccessTokenFor(p.deps.db, tokens.access_token!, p.isAllowed, BUILDER)?.email, BOB);

    const realNow = Date.now;
    try {
      // Eight days later: the request and the access token are gone, and so is the unused client.
      Date.now = () => realNow() + 8 * 24 * 3600_000;
      purgeOAuth(p.deps.db);
      purgeClients(p.deps.db);
      assert.equal(count(p, 'oauth_requests'), 0);
      assert.equal(count(p, 'oauth_tokens'), 1); // the refresh token
      assert.equal(count(p, 'oauth_clients'), 1);
      assert.equal(count(p, 'oauth_grants', 'revoked_at IS NULL'), 1);
      // Four months later the refresh token expired: the grant is dead, then forgotten with its client.
      Date.now = () => realNow() + 120 * 24 * 3600_000;
      purgeOAuth(p.deps.db);
      assert.equal(count(p, 'oauth_tokens'), 0);
      assert.equal(count(p, 'oauth_codes'), 0);
      assert.equal(count(p, 'oauth_grants', 'revoked_at IS NULL'), 0);
      purgeClients(p.deps.db);
      assert.equal(count(p, 'oauth_clients'), 0);
      Date.now = () => realNow() + 160 * 24 * 3600_000;
      purgeOAuth(p.deps.db);
      assert.equal(count(p, 'oauth_grants'), 0);
    } finally {
      Date.now = realNow;
    }
    // A member who is deleted takes their grants along.
    const again = await connected(p, ALICE, BUILDER);
    run(p.deps.db, 'DELETE FROM users WHERE email = :email', { email: ALICE });
    assert.equal(count(p, 'oauth_grants'), 0);
    assert.equal(verifyAccessToken(p.deps.db, again.tokens.access_token!, p.isAllowed), null);
  });
});
