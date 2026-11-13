import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Browser, CONTROL, DEMO, NOTES, setup, signIn, subscription, BOB } from './helpers.ts';

// Apps are sibling subdomains of one another and of the control plane. Browsers
// treat siblings as the same site, so SameSite cookies do not separate them:
// these tests pin down what does.

async function signedIn() {
  const ctx = setup();
  const browser = new Browser(ctx.app);
  signIn(ctx, browser, BOB);
  await browser.navigate(`${DEMO}/`);
  await browser.navigate(`${NOTES}/`);
  return { ctx, browser };
}

describe('requests from another origin', () => {
  it('refuses writes that do not come from a page of the same origin', async () => {
    const { ctx, browser } = await signedIn();
    const url = `${DEMO}/_socle/api/push/subscriptions`;
    const post = (headers: Record<string, string>) =>
      browser.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(subscription()),
      });

    assert.equal((await post({ origin: NOTES, 'sec-fetch-site': 'same-site' })).status, 403); // a sibling app
    assert.equal((await post({ origin: CONTROL, 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post({})).status, 403); // no Origin at all
    assert.equal((await post({ origin: 'null' })).status, 403); // sandboxed frame
    assert.equal((await post({ origin: DEMO, 'sec-fetch-site': 'same-site' })).status, 403); // headers disagree
    assert.equal((await post({ origin: `${DEMO}:8443` })).status, 403);
    assert.equal((await post({ origin: DEMO, 'sec-fetch-site': 'same-origin' })).status, 204);
    assert.equal((await post({ origin: DEMO })).status, 204); // older browser without fetch metadata
    ctx.cleanup();
  });

  it('refuses private reads started by another origin', async () => {
    const { ctx, browser } = await signedIn();
    const read = (site: string) =>
      browser.request(`${DEMO}/_socle/api/me`, { headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' } });
    assert.equal((await read('same-site')).status, 403);
    assert.equal((await read('cross-site')).status, 403);
    assert.equal((await read('same-origin')).status, 200);
    ctx.cleanup();
  });

  it('refuses a sign-out of the control plane sent from an app', async () => {
    const { ctx, browser } = await signedIn();
    const forged = await browser.request(`${CONTROL}/auth/logout`, {
      method: 'POST',
      headers: { origin: DEMO, 'sec-fetch-site': 'same-site' },
    });
    assert.equal(forged.status, 403);
    assert.equal((await browser.fetch(`${DEMO}/_socle/api/me`)).status, 200); // still signed in
    ctx.cleanup();
  });
});

describe('what an app page is allowed to do', () => {
  it('confines app pages to their own origin', async () => {
    const { ctx, browser } = await signedIn();
    const { response } = await browser.navigate(`${DEMO}/`);
    const csp = response.headers.get('content-security-policy')!;
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(csp.split('; ').includes(directive), directive);
    }
    assert.doesNotMatch(csp, /https?:|\*/); // no external source anywhere
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
    ctx.cleanup();
  });

  it('sends the policy with every response, so workers and stray documents are confined too', async () => {
    const { ctx, browser } = await signedIn();
    // A worker takes its policy from its own script response; an image or JSON file can be opened as a document.
    const paths = [
      `${ctx.assets}/main.js`,
      `${ctx.assets}/style.css`,
      '/_socle/api/me',
      '/_socle/vendor/sdk.js',
      '/_socle/sw.js',
    ];
    for (const path of paths) {
      const response = await browser.request(`${DEMO}${path}`);
      assert.equal(response.status, 200, path);
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes("connect-src 'self'") && csp.includes("script-src 'self'"), path);
    }
    const anonymous = await new Browser(ctx.app).request(`${DEMO}${ctx.assets}/main.js`);
    assert.match(anonymous.headers.get('content-security-policy') ?? '', /default-src 'self'/); // errors as well
    ctx.cleanup();
  });

  it('serves control-plane pages without any script', async () => {
    const { ctx, browser } = await signedIn();
    const response = await browser.request(`${CONTROL}/`);
    const csp = response.headers.get('content-security-policy')!;
    assert.ok(csp.split('; ').includes("default-src 'none'"));
    assert.doesNotMatch(csp, /script-src/);
    const page = await response.text();
    assert.doesNotMatch(page, /<script/i);
    assert.match(page, /href="https:\/\/demo\.apps\.test\/"/);
    // An app that was never published is not on the home page.
    assert.doesNotMatch(page, /notes\.apps\.test/);
    ctx.cleanup();
  });

  it('only lets the platform service worker be registered', async () => {
    const { ctx, browser } = await signedIn();
    const asWorker = { 'service-worker': 'script' };
    assert.equal((await browser.request(`${DEMO}${ctx.assets}/main.js`, { headers: asWorker })).status, 403);
    assert.equal((await browser.request(`${DEMO}/_socle/vendor/sdk.js`, { headers: asWorker })).status, 403);
    const worker = await browser.request(`${DEMO}/_socle/sw.js`, { headers: asWorker });
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('service-worker-allowed'), '/');
    assert.match(worker.headers.get('content-type')!, /^text\/javascript/);
    ctx.cleanup();
  });
});

describe('what is reachable without signing in', () => {
  it('only exposes what a browser needs to install the app', async () => {
    const ctx = setup();
    const anonymous = new Browser(ctx.app);
    for (const path of [
      '/_socle/manifest.webmanifest',
      '/_socle/sw.js',
      '/_socle/vendor/sdk.js',
      '/_socle/icons/icon-192.png',
    ]) {
      assert.equal((await anonymous.request(`${DEMO}${path}`)).status, 200, path);
    }
    const manifest = (await (await anonymous.request(`${DEMO}/_socle/manifest.webmanifest`)).json()) as {
      name: string;
      scope: string;
      icons: unknown[];
    };
    assert.equal(manifest.name, 'Demo');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.icons.length, 4);

    assert.equal((await anonymous.request(`${DEMO}${ctx.assets}/main.js`)).status, 401);
    assert.equal((await anonymous.fetch(`${DEMO}/_socle/api/me`)).status, 401);
    assert.equal((await anonymous.fetch(`${DEMO}/_socle/api/fn/list`, { method: 'POST', json: {} })).status, 401);
    assert.equal((await anonymous.fetch(`${DEMO}/_socle/api/events`)).status, 401);
    assert.equal((await anonymous.fetch(`${DEMO}/_socle/api/logout`, { method: 'POST' })).status, 401);
    assert.equal((await anonymous.request(`${DEMO}/`, { headers: { accept: 'text/html' } })).status, 302);
    ctx.cleanup();
  });

  it('answers nothing on hosts that are neither the control plane nor an app', async () => {
    const ctx = setup();
    const browser = new Browser(ctx.app);
    assert.equal((await browser.request('https://evil.example/')).status, 404);
    assert.equal((await browser.request('https://apps.test/')).status, 404);
    assert.equal((await browser.request('https://a.demo.apps.test/')).status, 404);
    assert.equal((await browser.request('http://127.0.0.1:8787/healthz')).status, 200);
    assert.equal((await browser.request(`${CONTROL}/healthz`)).status, 200);
    ctx.cleanup();
  });

  it('serves the app files to its members only, and 404s the rest', async () => {
    const { ctx, browser } = await signedIn();
    const script = await browser.request(`${DEMO}${ctx.assets}/main.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type')!, /^text\/javascript/);
    assert.match(script.headers.get('cache-control')!, /^private, .*immutable$/);
    assert.equal((await browser.request(`${DEMO}${ctx.assets}/style.css`)).status, 200);
    assert.equal((await browser.request(`${DEMO}${ctx.assets}/../../package.json`)).status, 404);
    assert.equal((await browser.request(`${DEMO}${ctx.assets}/missing.js`)).status, 404);
    assert.equal((await browser.request(`${DEMO}/assets/0000000000000000/main.js`)).status, 404);
    assert.equal((await browser.request(`${DEMO}/assets/main.js`)).status, 404);
    assert.equal((await browser.request(`${DEMO}/_socle/vendor/missing.js`)).status, 404);
    // Another app's files are not reachable under this app's host, even by their exact address.
    assert.equal((await browser.request(`${NOTES}${ctx.assets}/main.js`)).status, 404);
    assert.equal((await browser.request(`${DEMO}/_socle/unknown`)).status, 404);
    // An app without a published version shows a message instead of an empty shell.
    const empty = await browser.navigate(`${NOTES}/`);
    assert.equal(empty.response.status, 404);
    assert.match(await empty.response.text(), /no published version yet/);
    ctx.cleanup();
  });
});
