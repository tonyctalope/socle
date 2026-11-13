import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createGoogleProvider } from '../src/auth/google.ts';
import { all, get } from '../src/db/database.ts';
import {
  Browser,
  CHLOE,
  CONTROL,
  DEMO,
  NOTES,
  setup,
  STRANGER,
  subscription,
  TONY,
  type TestContext,
} from './helpers.ts';

// A fake Google: OIDC discovery, an /authorize that immediately redirects back
// with a code, a token endpoint returning an RS256-signed ID token, and JWKS.
// The platform talks to it with the real openid-client.

const CLIENT_ID = 'google-client';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Pending {
  nonce: string;
  email: string;
  verified: boolean;
  challenge: string;
}

describe('Google sign-in (OIDC) and the e-mail allowlist', () => {
  let issuer: string;
  let server: ServerType;
  let nextIdentity = { email: TONY, verified: true };
  const codes = new Map<string, Pending>();

  before(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const port = await freePort();
    issuer = `http://127.0.0.1:${port}`;
    const google = new Hono();
    google.get('/.well-known/openid-configuration', (c) =>
      c.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }),
    );
    google.get('/jwks', (c) => c.json({ keys: [jwk] }));
    google.get('/authorize', (c) => {
      const q = c.req.query();
      const code = `code-${codes.size + 1}-${Date.now()}`;
      codes.set(code, { nonce: q.nonce!, challenge: q.code_challenge!, ...nextIdentity });
      return c.redirect(`${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state!)}`, 302);
    });
    google.post('/token', async (c) => {
      const form = await c.req.parseBody();
      const pending = codes.get(String(form.code));
      codes.delete(String(form.code));
      if (!pending) return c.json({ error: 'invalid_grant' }, 400);
      const verifier = String(form.code_verifier);
      const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString(
        'base64url',
      );
      if (digest !== pending.challenge) return c.json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
      const idToken = await new SignJWT({
        email: pending.email,
        email_verified: pending.verified,
        name: pending.email.split('@')[0],
        nonce: pending.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(CLIENT_ID)
        .setSubject(`google-${pending.email}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return c.json({ access_token: 'google-at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    });
    server = serve({ fetch: google.fetch, port, hostname: '127.0.0.1' });
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function start(): { ctx: TestContext; browser: Browser } {
    const ctx = setup({ env: { GOOGLE_ISSUER: issuer } });
    // Routes read deps.identity per request, so swapping it in is enough.
    ctx.deps.identity = createGoogleProvider(ctx.deps.config, { allowInsecure: true });
    const browser = new Browser(ctx.app);
    browser.external.push(issuer);
    return { ctx, browser };
  }

  it('takes an anonymous visitor from an app page to Google and back to that page, signed in', async () => {
    const { ctx, browser } = start();
    nextIdentity = { email: TONY, verified: true };
    const { response, url, hops } = await browser.navigate(`${DEMO}/depenses?mois=11`);
    assert.equal(response.status, 200);
    assert.equal(url, `${DEMO}/depenses?mois=11`);
    assert.deepEqual(
      hops.map((hop) => new URL(hop).origin + new URL(hop).pathname),
      [
        `${DEMO}/depenses`,
        `${DEMO}/_socle/login`,
        `${CONTROL}/sso/start`,
        `${CONTROL}/auth/google/start`,
        `${issuer}/authorize`,
        `${CONTROL}/auth/google/callback`,
        `${CONTROL}/sso/start`,
        `${DEMO}/_socle/sso`,
        `${DEMO}/depenses`,
      ],
    );
    const atGoogle = new URL(hops[4]!);
    assert.equal(atGoogle.searchParams.get('redirect_uri'), `${CONTROL}/auth/google/callback`);
    assert.equal(atGoogle.searchParams.get('code_challenge_method'), 'S256');

    const session = browser.setCookies.find((cookie) => cookie.startsWith('__Host-socle_session='))!;
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    assert.match(session, /Secure/i);
    assert.doesNotMatch(session, /domain=/i);
    assert.equal(browser.cookie(CONTROL, '__Host-socle_login'), undefined); // one-shot login cookie cleared

    const me = (await (await browser.fetch(`${DEMO}/_socle/api/me`)).json()) as { user: { name: string } };
    assert.equal(me.user.name, 'tony');
    // The home page now greets them and lists the apps.
    assert.match(await (await browser.request(`${CONTROL}/`)).text(), /Bonjour tony/);
    ctx.cleanup();
  });

  it('refuses accounts outside the allowlist or with an unverified e-mail', async () => {
    const { ctx, browser } = start();
    nextIdentity = { email: STRANGER, verified: true };
    const stranger = await browser.navigate(`${DEMO}/`);
    assert.equal(stranger.response.status, 403);
    assert.equal(new URL(stranger.url).pathname, '/auth/google/callback');
    assert.match(await stranger.response.text(), new RegExp(STRANGER));
    assert.equal(browser.cookie(CONTROL, '__Host-socle_session'), undefined);
    assert.equal(browser.cookie(DEMO, '__Host-socle_app'), undefined);

    nextIdentity = { email: CHLOE, verified: false };
    assert.equal((await browser.navigate(`${CONTROL}/auth/google/start`)).response.status, 403);
    ctx.cleanup();
  });

  it('keeps nothing on the server for a login in progress, so strangers cannot lock members out', async () => {
    const { ctx, browser } = start();
    const tables = all<{ name: string }>(ctx.deps.db, "SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.deepEqual(tables.map((table) => table.name).sort(), [
      'app_versions',
      'apps',
      'push_subscriptions',
      'sessions',
      'settings',
      'sso_codes',
      'users',
    ]);
    // Thousands of abandoned attempts from many addresses…
    for (let i = 0; i < 6000; i++) {
      const abandoned = await ctx.app.request(`${CONTROL}/auth/google/start`, {
        headers: { 'x-forwarded-for': `203.0.${Math.floor(i / 250)}.${i % 250}` },
      });
      assert.equal(abandoned.status, 302);
    }
    // …and a member still signs in.
    nextIdentity = { email: TONY, verified: true };
    assert.equal((await browser.navigate(`${DEMO}/`)).response.status, 200);
    ctx.cleanup();
  });

  it('keeps a long deep link through the whole detour', async () => {
    const { ctx, browser } = start();
    nextIdentity = { email: TONY, verified: true };
    const deep = `/recherche?q=${encodeURIComponent('é'.repeat(40))}&tri=date`; // 283 characters once encoded
    assert.ok(deep.length > 250 && deep.length < 300);
    const { response, url } = await browser.navigate(`${DEMO}${deep}`);
    assert.equal(response.status, 200);
    assert.equal(url, `${DEMO}${deep}`);
    ctx.cleanup();
  });

  it('ends what another member left on a shared browser, and keeps what the same member had', async () => {
    const { ctx, browser } = start();
    nextIdentity = { email: TONY, verified: true };
    await browser.navigate(`${DEMO}/`);
    const mine = subscription();
    assert.equal(
      (await browser.fetch(`${DEMO}/_socle/api/push/subscriptions`, { method: 'POST', json: mine })).status,
      204,
    );

    // Tony's control-plane cookie is gone (expired), his app session is still there. He signs in again.
    browser.deleteCookie(CONTROL, '__Host-socle_session');
    await browser.navigate(`${NOTES}/`);
    const tony = (await (await browser.fetch(`${DEMO}/_socle/api/me`)).json()) as {
      user: { name: string };
      push: { subscriptions: number };
    };
    assert.equal(tony.user.name, 'tony');
    assert.equal(tony.push.subscriptions, 1); // nothing of his was touched

    // Same situation, but this time Chloé signs in on that browser.
    browser.deleteCookie(CONTROL, '__Host-socle_session');
    nextIdentity = { email: CHLOE, verified: true };
    await browser.navigate(`${CONTROL}/auth/google/start`);
    assert.match(await (await browser.request(`${CONTROL}/`)).text(), /Bonjour chloe/);
    // Tony's session on the app host no longer answers, and his notifications stopped coming here.
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 401);
    assert.equal(get<{ n: number }>(ctx.deps.db, 'SELECT COUNT(*) AS n FROM push_subscriptions')!.n, 0);
    await browser.navigate(`${DEMO}/`);
    const chloe = (await (await browser.fetch(`${DEMO}/_socle/api/me`)).json()) as { user: { name: string } };
    assert.equal(chloe.user.name, 'chloe');
    ctx.cleanup();
  });

  it('rejects a callback whose state does not match the browser', async () => {
    const { ctx, browser } = start();
    nextIdentity = { email: TONY, verified: true };
    const begin = await browser.request(`${CONTROL}/auth/google/start`);
    const back = await browser.request(begin.headers.get('location')!);
    const callback = new URL(back.headers.get('location')!);
    callback.searchParams.set('state', 'forged');
    assert.equal((await browser.request(callback.href)).status, 400);
    assert.equal(browser.cookie(CONTROL, '__Host-socle_session'), undefined);

    // Without the cookie of the browser that started (a link opened elsewhere), nothing either.
    const again = await browser.request(`${CONTROL}/auth/google/start`);
    const real = (await browser.request(again.headers.get('location')!)).headers.get('location')!;
    const elsewhere = new Browser(ctx.app);
    assert.equal((await elsewhere.request(real)).status, 400);
    ctx.cleanup();
  });
});
