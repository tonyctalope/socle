import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { get, run } from '../src/db/database.ts';
import { Browser, CHLOE, CONTROL, DEMO, NOTES, setup, signIn, testConfig, TONY } from './helpers.ts';

/** Starts sign-on on an app host and stops at the control plane's redirect back, without following it. */
async function codeFor(browser: Browser, appOrigin: string): Promise<string> {
  browser.deleteCookie(appOrigin, '__Host-socle_app'); // an already signed-in host skips the flow
  const login = await browser.request(`${appOrigin}/_socle/login?next=/`);
  const start = await browser.request(login.headers.get('location')!);
  const back = new URL(start.headers.get('location')!);
  assert.equal(back.origin, appOrigin);
  assert.equal(back.pathname, '/_socle/sso');
  return back.searchParams.get('code')!;
}

describe('sign-on from the control plane to an app host', () => {
  it('sends an anonymous visitor to sign in, then would come back to the same page', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    const first = await browser.request(`${DEMO}/depenses?mois=11`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), '/_socle/login?next=%2Fdepenses%3Fmois%3D11');

    const login = await browser.request(`${DEMO}${first.headers.get('location')}`);
    const atControl = new URL(login.headers.get('location')!);
    assert.equal(atControl.origin, CONTROL);
    assert.equal(atControl.pathname, '/sso/start');
    assert.equal(atControl.searchParams.get('app'), 'demo');
    assert.equal(atControl.searchParams.get('next'), '/depenses?mois=11');
    assert.equal(atControl.searchParams.get('state'), browser.cookie(DEMO, '__Host-socle_sso'));

    // Not signed in on the control plane: Google first, and the way back is kept server-side.
    const start = await browser.request(atControl.href);
    assert.equal(start.status, 302);
    const google = new URL(start.headers.get('location')!, CONTROL);
    assert.equal(google.pathname, '/auth/google/start');
    assert.match(google.searchParams.get('next')!, /^\/sso\/start\?app=demo&state=/);
    ctx.cleanup();
  });

  it('gives a signed-in member a session on the app host, on the page they asked for', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    const { response, url, hops } = await browser.navigate(`${DEMO}/depenses?mois=11`);
    assert.equal(response.status, 200);
    assert.equal(url, `${DEMO}/depenses?mois=11`);
    assert.deepEqual(
      hops.map((hop) => new URL(hop).origin + new URL(hop).pathname),
      [`${DEMO}/depenses`, `${DEMO}/_socle/login`, `${CONTROL}/sso/start`, `${DEMO}/_socle/sso`, `${DEMO}/depenses`],
    );
    assert.match(await response.text(), /<script type="module" src="\/assets\/main\.js">/);

    const me = await browser.fetch(`${DEMO}/_socle/api/me`);
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: Record<string, unknown>; app: { slug: string } };
    assert.deepEqual(body.user, { id: body.user.id, name: 'tony' }); // no e-mail address for apps
    assert.equal(body.app.slug, 'demo');
    assert.equal(browser.cookie(DEMO, '__Host-socle_sso'), undefined); // one-shot state cookie cleared
    ctx.cleanup();
  });

  it('only sets host-only, HttpOnly, Secure cookies', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    await browser.navigate(`${DEMO}/`);
    await browser.navigate(`${NOTES}/`);
    assert.ok(browser.setCookies.length >= 4);
    for (const header of browser.setCookies) {
      assert.match(header, /^__Host-socle_(app|sso)=/, header);
      assert.match(header, /;\s*Path=\/(;|$)/i, header);
      assert.match(header, /;\s*Secure/i, header);
      assert.doesNotMatch(header, /domain=/i, header);
      if (/max-age=0/i.test(header)) continue; // a deletion carries no value to protect
      assert.match(header, /;\s*HttpOnly/i, header);
      assert.match(header, /;\s*SameSite=Lax/i, header);
    }
    ctx.cleanup();
  });

  it('accepts a code once, only on its host, only in the browser that asked, and only for a minute', async () => {
    const ctx = setup();
    const tony = new Browser(ctx.app);
    signIn(ctx, tony, TONY);

    // Once.
    const used = await codeFor(tony, DEMO);
    const state = tony.cookie(DEMO, '__Host-socle_sso')!;
    assert.equal((await tony.request(`${DEMO}/_socle/sso?code=${used}`)).status, 303);
    tony.deleteCookie(DEMO, '__Host-socle_app');
    tony.setCookie(DEMO, '__Host-socle_sso', state);
    assert.equal((await tony.request(`${DEMO}/_socle/sso?code=${used}`)).status, 400);

    // Only on its host: a code issued for demo is refused by notes, even with notes' own state cookie.
    const forDemo = await codeFor(tony, DEMO);
    await tony.request(`${NOTES}/_socle/login?next=/`);
    assert.equal((await tony.request(`${NOTES}/_socle/sso?code=${forDemo}`)).status, 400);
    // …and that failed attempt burned it.
    tony.setCookie(DEMO, '__Host-socle_sso', tony.cookie(DEMO, '__Host-socle_sso') ?? state);
    assert.equal((await tony.request(`${DEMO}/_socle/sso?code=${forDemo}`)).status, 400);

    // Only in the browser that started the flow: someone made to open the link gets nothing.
    const leaked = await codeFor(tony, DEMO);
    const victim = new Browser(ctx.app);
    const refused = await victim.request(`${DEMO}/_socle/sso?code=${leaked}`);
    assert.equal(refused.status, 400);
    assert.equal(victim.cookie(DEMO, '__Host-socle_app'), undefined);
    await victim.request(`${DEMO}/_socle/login?next=/`); // a state cookie of its own does not help
    const fresh = await codeFor(tony, DEMO);
    assert.equal((await victim.request(`${DEMO}/_socle/sso?code=${fresh}`)).status, 400);

    // Only for a minute.
    const late = await codeFor(tony, DEMO);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    assert.equal((await tony.request(`${DEMO}/_socle/sso?code=${late}`)).status, 400);
    ctx.cleanup();
  });

  it('lets two tabs sign in at the same time', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    // Two tabs restored together: each starts its own sign-on, the second state replaces the first.
    const first = await browser.request(`${DEMO}/_socle/login?next=/a`);
    const second = await browser.request(`${DEMO}/_socle/login?next=/b`);
    const firstBack = (await browser.request(first.headers.get('location')!)).headers.get('location')!;
    const secondBack = (await browser.request(second.headers.get('location')!)).headers.get('location')!;
    const b = await browser.request(secondBack);
    assert.equal(b.status, 303);
    assert.equal(b.headers.get('location'), '/b');
    // The first tab comes back with a state that is gone, but the browser is signed in now.
    const a = await browser.request(firstBack);
    assert.equal(a.status, 303);
    assert.equal(a.headers.get('location'), '/a');
    // A signed-in browser gains nothing from someone else's code: no session change, no chosen landing page.
    const chloe = new Browser(ctx.app);
    signIn(ctx, chloe, CHLOE);
    const hers = await codeFor(chloe, DEMO);
    const swapped = await browser.request(`${DEMO}/_socle/sso?code=${hers}`);
    assert.equal(swapped.headers.get('location'), '/');
    const me = (await (await browser.fetch(`${DEMO}/_socle/api/me`)).json()) as { user: { name: string } };
    assert.equal(me.user.name, 'tony');
    ctx.cleanup();
  });

  it('only runs the sign-on steps for a page the tab navigates to', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    const state = 'a'.repeat(43);
    const background = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', 'sec-fetch-site': 'same-site' };
    const framed = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' };
    for (const headers of [background, framed]) {
      const start = await browser.request(`${CONTROL}/sso/start?app=demo&state=${state}`, { headers });
      assert.equal(start.status, 400);
      assert.equal(start.headers.get('location'), null); // no code issued
      assert.equal((await browser.request(`${DEMO}/_socle/login`, { headers })).status, 400);
      assert.equal((await browser.request(`${DEMO}/_socle/sso?code=${state}`, { headers })).status, 400);
    }
    assert.equal(get<{ n: number }>(ctx.deps.db, 'SELECT COUNT(*) AS n FROM sso_codes')!.n, 0);
    assert.equal(browser.cookie(DEMO, '__Host-socle_sso'), undefined);
    ctx.cleanup();
  });

  it('keeps a session alive while it is used, and ends it after six months anyway', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    await browser.navigate(`${DEMO}/`);
    const before = browser.setCookies.length;
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 200);
    assert.equal(browser.setCookies.length, before); // nothing to renew yet

    // Two hours later the expiry slides, and the browser gets the cookie again with a fresh lifetime.
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    run(ctx.deps.db, 'UPDATE sessions SET last_seen_at = :seen', { seen: ago(2 * 3600_000) });
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 200);
    const renewed = browser.setCookies.at(-1)!;
    assert.match(renewed, /^__Host-socle_app=/);
    assert.match(renewed, /Max-Age=2592000/);
    assert.match(renewed, /HttpOnly/i);
    assert.equal((await browser.request(`${CONTROL}/`)).headers.getSetCookie().length, 1); // the control plane too

    // Unused for more than 30 days: over.
    run(ctx.deps.db, "UPDATE sessions SET expires_at = :past WHERE scope = 'demo'", { past: ago(1000) });
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 401);
    // Used every day, but created more than 180 days ago: over as well.
    run(ctx.deps.db, "UPDATE sessions SET created_at = :old WHERE scope = ''", { old: ago(181 * 86_400_000) });
    assert.match(await (await browser.request(`${CONTROL}/`)).text(), /Se connecter avec Google/);
    ctx.cleanup();
  });

  it('never accepts a session on another host than its own', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    await browser.navigate(`${DEMO}/`);
    const demoSession = browser.cookie(DEMO, '__Host-socle_app')!;
    const controlSession = browser.cookie(CONTROL, '__Host-socle_session')!;

    const other = new Browser(ctx.app);
    other.setCookie(NOTES, '__Host-socle_app', demoSession); // demo's session presented to notes
    assert.equal((await other.fetch(`${NOTES}/_socle/api/me`)).status, 401);
    other.setCookie(NOTES, '__Host-socle_app', controlSession); // the control plane's presented to an app
    assert.equal((await other.fetch(`${NOTES}/_socle/api/me`)).status, 401);
    other.setCookie(CONTROL, '__Host-socle_session', demoSession); // an app's presented to the control plane
    assert.match(await (await other.request(`${CONTROL}/`)).text(), /Se connecter avec Google/);
    ctx.cleanup();
  });

  it('never redirects outside the app after sign-on', async () => {
    const ctx = setup();
    for (const next of ['//evil.example/', 'https://evil.example/', '/_socle/login']) {
      const browser = new Browser(ctx.app);
      signIn(ctx, browser, TONY);
      const { url } = await browser.navigate(`${DEMO}/_socle/login?next=${encodeURIComponent(next)}`);
      assert.equal(url, `${DEMO}/`, next);
    }
    ctx.cleanup();
  });

  it('answers 404 for an app that does not exist, on its host and on the control plane', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    signIn(ctx, browser, TONY);
    assert.equal((await browser.navigate('https://ghost.apps.test/')).response.status, 404);
    const state = 'a'.repeat(43);
    assert.equal((await browser.request(`${CONTROL}/sso/start?app=ghost&state=${state}&next=/`)).status, 404);
    assert.equal((await browser.request(`${CONTROL}/sso/start?app=Demo&state=${state}`)).status, 400);
    assert.equal((await browser.request(`${CONTROL}/sso/start?app=demo&state=short`)).status, 400);
    ctx.cleanup();
  });

  it('signs out everywhere on that browser, from an app or from the control plane', async () => {
    const ctx = setup();
    const phone = new Browser(ctx.app);
    const laptop = new Browser(ctx.app);
    signIn(ctx, phone, TONY);
    signIn(ctx, laptop, TONY);
    for (const browser of [phone, laptop]) {
      await browser.navigate(`${DEMO}/`);
      await browser.navigate(`${NOTES}/`);
    }

    const out = await phone.fetch(`${DEMO}/_socle/api/logout`, { method: 'POST' });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { url: `${CONTROL}/` });
    assert.equal((await phone.fetch(`${NOTES}/_socle/api/me`)).status, 401); // the other app too
    assert.match(await (await phone.request(`${CONTROL}/`)).text(), /Se connecter avec Google/);
    assert.equal((await laptop.fetch(`${NOTES}/_socle/api/me`)).status, 200); // another device is untouched

    const form = await laptop.request(`${CONTROL}/auth/logout`, { method: 'POST', headers: { origin: CONTROL } });
    assert.equal(form.status, 303);
    assert.equal((await laptop.fetch(`${DEMO}/_socle/api/me`)).status, 401);
    assert.equal(get<{ n: number }>(ctx.deps.db, 'SELECT COUNT(*) AS n FROM sessions')!.n, 0);
    ctx.cleanup();
  });

  it('drops the sessions of an account removed from the allowlist', async () => {
    const before = setup();
    const browser = new Browser(before.app);
    signIn(before, browser, CHLOE);
    await browser.navigate(`${DEMO}/`);
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 200);

    // Same database, allowlist without her: the next request of each session is refused.
    const restricted = new Browser(createApp({ ...before.deps, config: testConfig({ ALLOWED_EMAILS: TONY }) }));
    restricted.setCookie(DEMO, '__Host-socle_app', browser.cookie(DEMO, '__Host-socle_app')!);
    restricted.setCookie(CONTROL, '__Host-socle_session', browser.cookie(CONTROL, '__Host-socle_session')!);
    assert.equal((await restricted.fetch(`${DEMO}/_socle/api/me`)).status, 401);
    assert.match(await (await restricted.request(`${CONTROL}/`)).text(), /Se connecter avec Google/);
    assert.equal(get<{ n: number }>(before.deps.db, 'SELECT COUNT(*) AS n FROM sessions')!.n, 0);
    before.cleanup();
  });
});
