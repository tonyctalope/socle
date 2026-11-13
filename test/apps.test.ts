import assert from 'node:assert/strict';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { CallGate } from '../src/apphost/gate.ts';
import { VendorCache } from '../src/apphost/vendor.ts';
import { DEMO_SLUG, syncDemoApp } from '../src/apps/demo.ts';
import { backupApps } from '../src/jobs.ts';
import { RunnerUnavailable } from '../src/runner/client.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, Browser, CONTROL, DEMO, setup, signIn, type TestContext } from './helpers.ts';

// Apps end to end, as browsers see them: sources go in, the runner builds them, and
// pages call the app's server functions through the platform.

const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 400, killGraceMs: 300 };
const GROCERIES = 'https://groceries.apps.test';
const SECRETS = 'https://secrets.apps.test';

const groceries = (extra: Record<string, string> = {}) => ({
  'app.json': JSON.stringify({ name: 'Groceries', description: 'The shared shopping list', themeColor: '#2F5D8A' }),
  'web/main.tsx': `
    import { useQuery } from '@socle/sdk';
    import { Page } from '@socle/ui';
    export default function App() {
      const items = useQuery('list');
      return <Page title="Groceries"><p className="text-brand md:p-4">{JSON.stringify(items.data)}</p></Page>;
    }`,
  'web/style.css': '@theme { --color-brand: #0a7a3d; }',
  'migrations/001_init.sql':
    'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, author INTEGER NOT NULL);',
  'server/index.ts': `
    import { fail, mutation, query, v } from '@socle/server';
    export const list = query(({ db }) => db.all('SELECT id, label, author FROM items ORDER BY id'));
    export const context = query(({ user, members, now, today }) => ({ user, members, now, today }));
    export const add = mutation({
      input: v.object({ label: v.string().min(1).max(40) }),
      handler: ({ db, user, notify }, { label }) => {
        if (label === 'forbidden') fail('Not that.', 'forbidden_item');
        if (label === 'bug') return undefinedVariable;
        const { lastInsertRowid } = db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id);
        notify('others', { title: user.name + ' added ' + label, url: '/item/' + lastInsertRowid });
        notify([user.id, 999], { title: 'Added', body: label });
        return lastInsertRowid;
      },
    });
    export const noisy = query(() => { console.log('hello from the app'); return 1; });
    export const loud = query(({}, { size }) => fail('x'.repeat(size), 'c'.repeat(size)));
    export const echo = query(({}, input) => input);
    export const spin = query(() => { for (;;) {} });
  `,
  ...extra,
});

describe('an app, from its sources to the browser', () => {
  let ctx: TestContext;
  let bob: Browser;
  let alice: Browser;
  let bobId: number;
  let aliceId: number;

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS, env: { APP_TIMEZONE: 'Europe/Paris' } });
    // A shorter patience than in production, so that the flood test does not take long.
    ctx.deps.gate = new CallGate({ perApp: 2, waitingPerApp: 16, maxWaitMs: 1_500 });
    ctx.deps.streamPingMs = 40;
    bob = new Browser(ctx.app);
    alice = new Browser(ctx.app);
    bobId = signIn(ctx, bob, BOB).userId;
    aliceId = signIn(ctx, alice, ALICE).userId;
    assert.deepEqual(await ctx.deps.apps.deploy('groceries', groceries(), { id: bobId }), {
      ok: true,
      versionId: 2,
      unchanged: false,
      applied: ['001_init.sql'],
    });
    await bob.navigate(`${GROCERIES}/`);
    await alice.navigate(`${GROCERIES}/`);
  });
  after(() => ctx.cleanup());

  const call = (browser: Browser, name: string, body: unknown = {}, origin = GROCERIES) =>
    browser.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: body });
  const value = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { value: unknown }).value;
  };

  it('serves a page written by the platform around the built app', async () => {
    const { response } = await bob.navigate(`${GROCERIES}/liste?x=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.text();
    assert.match(page, /<title>Groceries<\/title>/);
    assert.match(page, /<meta name="theme-color" content="#2f5d8a" \/>/);
    assert.match(page, /<link rel="stylesheet" href="\/_socle\/vendor\/ui\.css" \/>/);
    const script = /<script type="module" src="(\/assets\/[0-9a-f]{16}\/main\.js)"><\/script>/.exec(page)?.[1];
    assert.ok(script);
    assert.equal((page.match(/<script/g) ?? []).length, 2, 'the boot data and the app, nothing else');

    // What the app's code learns about people: ids and display names, never an e-mail address.
    const boot = JSON.parse(
      /<script id="socle-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page)![1]!,
    ) as {
      user: unknown;
      members: unknown;
      app: unknown;
      push: { publicKey: string };
    };
    assert.deepEqual(boot.user, { id: bobId, name: 'bob' });
    assert.deepEqual(boot.members, [
      { id: bobId, name: 'bob' },
      { id: aliceId, name: 'alice' },
    ]);
    assert.deepEqual(boot.app, { slug: 'groceries', name: 'Groceries' });
    assert.equal(boot.push.publicKey, ctx.push.publicKey);
    assert.doesNotMatch(page, /@example\./);

    const js = await (await bob.request(`${GROCERIES}${script}`)).text();
    assert.match(js, /from"\/_socle\/vendor\/sdk\.js"/);
    assert.doesNotMatch(js, /node_modules|createElement\(/, 'React is not bundled into the app');
    const css = await (await bob.request(`${GROCERIES}${script.replace('main.js', 'style.css')}`)).text();
    assert.match(css, /\.text-brand\{color:var\(--color-brand\)\}/);
    assert.match(css, /--color-brand: ?#0a7a3d/);
    assert.doesNotMatch(css, /box-sizing/, 'base styles come once, from the platform stylesheet');
  });

  it('cannot break out of the page through a name', async () => {
    const hostile = '</script><script>alert(1)</script><!--';
    ctx.deps.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(hostile, aliceId);
    try {
      const page = await (await bob.navigate(`${GROCERIES}/`)).response.text();
      assert.equal((page.match(/<script/g) ?? []).length, 2);
      assert.doesNotMatch(page, /alert\(1\)<\/script>/);
      const boot = JSON.parse(
        /<script id="socle-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page)![1]!,
      ) as {
        members: { name: string }[];
      };
      assert.equal(boot.members[1]!.name, hostile);
    } finally {
      ctx.deps.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('alice', aliceId);
    }
  });

  it('runs the app’s functions for signed-in members, with who they are', async () => {
    assert.deepEqual(await value(await call(bob, 'list')), []);
    assert.equal(await value(await call(bob, 'add', { input: { label: 'Pain' } })), 1);
    assert.equal(await value(await call(alice, 'add', { input: { label: 'Lait' } })), 2);
    assert.deepEqual(await value(await call(alice, 'list', { query: true })), [
      { id: 1, label: 'Pain', author: bobId },
      { id: 2, label: 'Lait', author: aliceId },
    ]);
    ctx.clock.now = new Date('2027-01-15T23:30:00Z'); // already the 16th in Paris
    assert.deepEqual(await value(await call(alice, 'context')), {
      user: { id: aliceId, name: 'alice' },
      members: [
        { id: bobId, name: 'bob' },
        { id: aliceId, name: 'alice' },
      ],
      now: Date.parse('2027-01-15T23:30:00Z'),
      today: '2027-01-16',
    });
    ctx.clock.now = new Date();
  });

  it('answers failures in a way the page can show', async () => {
    const problem = async (response: Response) => ({ status: response.status, ...((await response.json()) as object) });
    assert.deepEqual(await problem(await call(bob, 'add', { input: { label: '' } })), {
      status: 400,
      error: 'invalid_input',
      message: 'input.label: must not be empty',
    });
    assert.deepEqual(await problem(await call(bob, 'add', { input: { label: 'forbidden' } })), {
      status: 422,
      error: 'forbidden_item',
      message: 'Not that.',
    });
    // A bug of the app says nothing about its insides to the browser.
    assert.deepEqual(await problem(await call(bob, 'add', { input: { label: 'bug' } })), {
      status: 500,
      error: 'app_error',
      message: 'The app ran into an error.',
    });
    assert.deepEqual(await problem(await call(bob, 'spin')), {
      status: 504,
      error: 'timeout',
      message: 'The app took too long to answer.',
    });
    assert.equal((await call(bob, 'nope')).status, 404);
    assert.equal((await call(bob, 'toString')).status, 404);
    assert.equal((await call(bob, 'add', 'not an object')).status, 400);
    assert.equal((await bob.request(`${GROCERIES}/_socle/api/fn/add`, { method: 'POST', body: '{}' })).status, 403);
    // A screen that only reads never writes by accident.
    const mistaken = await call(bob, 'add', { query: true, input: { label: 'Fantôme' } });
    assert.deepEqual(await problem(mistaken), {
      status: 400,
      error: 'not_a_query',
      message: 'add changes data: call it with api.add().',
    });
    assert.equal(((await value(await call(bob, 'list'))) as unknown[]).length, 2);
  });

  it('keeps answers and requests within bounds, whatever the app or the page sends', async () => {
    // A function that fails with megabytes of text: the page gets a short answer.
    const loud = await call(bob, 'loud', { input: { size: 3_000_000 } });
    assert.equal(loud.status, 422);
    const body = await loud.text();
    assert.ok(body.length < 2_500, `an error answer of ${body.length} characters`);
    assert.equal((JSON.parse(body) as { error: string }).error, 'failed');
    // Input nested deeper than anything can carry is refused as input, not as a crash.
    const deep = `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`;
    const nested = await bob.request(`${GROCERIES}/_socle/api/fn/echo`, {
      method: 'POST',
      headers: { origin: GROCERIES, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: `{"input":${deep}}`,
    });
    assert.equal(nested.status, 400);
    assert.equal(((await nested.json()) as { error: string }).error, 'invalid_input');
    // What a function returns reaches the page as it is, whatever is in it.
    const tricky = { text: '</script>"\\\u2028', list: [1, [2, [3]]], nothing: null };
    assert.deepEqual(await value(await call(bob, 'echo', { input: tricky })), tricky);
    // Sixty-four levels are plenty; more is refused before any function sees it.
    const nest = (levels: number) => ({ input: JSON.parse(`${'['.repeat(levels)}1${']'.repeat(levels)}`) as unknown });
    assert.equal((await call(bob, 'echo', nest(64))).status, 200);
    assert.equal((await call(bob, 'echo', nest(65))).status, 400);
    assert.equal(
      (await call(bob, 'echo', { input: { text: '[[['.repeat(100) } })).status,
      200,
      'brackets in text are text',
    );
  });

  it('refuses calls that do not come from the app’s own pages', async () => {
    const before = ((await value(await call(bob, 'list'))) as unknown[]).length;
    const url = `${GROCERIES}/_socle/api/fn/add`;
    const json = { input: { label: 'Intrus' } };
    // A page of another app, of the control plane, or of anywhere else, with Bob's cookies attached.
    for (const pageOrigin of [DEMO, 'https://socle.test', 'https://evil.example']) {
      assert.equal((await bob.fetch(url, { method: 'POST', json, pageOrigin })).status, 403, pageOrigin);
    }
    assert.equal((await bob.request(url, { method: 'POST', body: JSON.stringify(json) })).status, 403, 'no Origin');
    assert.equal((await bob.fetch(url, { method: 'GET' })).status, 404);
    assert.equal((await new Browser(ctx.app).fetch(url, { method: 'POST', json })).status, 401);
    // A session of another app is worth nothing here.
    const elsewhere = new Browser(ctx.app);
    signIn(ctx, elsewhere, BOB);
    await elsewhere.navigate(`${DEMO}/`);
    elsewhere.setCookie(GROCERIES, '__Host-socle_app', elsewhere.cookie(DEMO, '__Host-socle_app')!);
    assert.equal((await elsewhere.fetch(url, { method: 'POST', json })).status, 401);
    assert.equal(((await value(await call(bob, 'list'))) as unknown[]).length, before);
  });

  it('keeps each app’s data to itself', async () => {
    const outcome = await ctx.deps.apps.deploy(
      'secrets',
      groceries({
        'app.json': '{ "name": "Secrets" }',
        'server/index.ts': `
          import { mutation, query } from '@socle/server';
          export const list = query(({ db }) => db.all('SELECT label FROM items'));
          export const add = mutation(({ db, user }, { label }) => db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id).changes);
          export const steal = query(({ db }, { sql }) => db.all(sql));
        `,
      }),
      null,
    );
    assert.ok(outcome.ok);
    await bob.navigate(`${SECRETS}/`);
    assert.equal(await value(await call(bob, 'add', { input: { label: 'code du coffre' } }, SECRETS)), 1);
    assert.deepEqual(await value(await call(bob, 'list', {}, SECRETS)), [{ label: 'code du coffre' }]);
    const labels = ((await value(await call(bob, 'list'))) as { label: string }[]).map((item) => item.label);
    assert.ok(!labels.includes('code du coffre'));
    // The function exists in one app only, and that app cannot name the other's database.
    assert.equal((await call(bob, 'steal', { input: { sql: 'SELECT 1' } })).status, 404);
    for (const sql of [
      "ATTACH 'groceries/live.db' AS c",
      'SELECT * FROM groceries.items',
      'SELECT * FROM pragma_database_list',
    ]) {
      assert.equal((await call(bob, 'steal', { input: { sql } }, SECRETS)).status, 500, sql);
    }
  });

  it('sends the notifications a mutation asked for, to members of the app only', async () => {
    ctx.push.sent.length = 0;
    const id = await value(await call(bob, 'add', { input: { label: 'Œufs' } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      ctx.push.sent.map((sent) => ({ ...sent, message: { ...sent.message, tag: undefined } })),
      [
        {
          userId: aliceId,
          app: 'groceries',
          message: { title: 'bob added Œufs', body: '', url: `/item/${id}`, tag: undefined },
        },
        // 999 is nobody: dropped.
        { userId: bobId, app: 'groceries', message: { title: 'Added', body: 'Œufs', url: '/', tag: undefined } },
      ],
    );
    // A call that fails notifies nobody.
    ctx.push.sent.length = 0;
    await call(bob, 'add', { input: { label: 'forbidden' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.push.sent.length, 0);
  });

  /** Opens the event stream of a page and returns a way to wait for its next event. */
  async function events(browser: Browser, origin = GROCERIES) {
    const response = await browser.request(`${origin}/_socle/api/events`, {
      headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // One read at a time: a read abandoned at a timeout would swallow the next chunk.
    let reading: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
    const next = async (pattern: RegExp, timeoutMs = 2_000): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = pattern.exec(buffer);
        if (found) {
          buffer = buffer.slice(found.index + found[0].length);
          return found[1] ?? found[0];
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !reader) return null;
        reading ??= reader.read();
        const chunk = await Promise.race([
          reading,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (chunk === null) return null;
        reading = undefined;
        if (chunk.done) return /closed/.test(String(pattern)) ? 'closed' : null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { response, next, close: () => reader?.cancel() };
  }

  it('tells every open page when the app’s data changed', async () => {
    const stream = await events(alice);
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get('content-type')!, /^text\/event-stream/);
    assert.match(stream.response.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.equal(await stream.next(/retry: (\d+)\n\n/), '3000');
    assert.equal(ctx.deps.live.count('groceries'), 1);

    // Bob changes something from a page that names itself: Alice's page hears about it.
    await bob.fetch(`${GROCERIES}/_socle/api/fn/add`, {
      method: 'POST',
      json: { input: { label: 'Beurre' } },
      headers: { 'x-socle-client': 'tab1' },
    });
    assert.equal(await stream.next(/event: change\ndata: (.*)\n\n/), '{"client":"tab1"}');
    // Reading changes nothing, a refused call neither, and another app's changes are not hers to hear.
    await call(bob, 'list');
    await call(bob, 'add', { input: { label: 'forbidden' } });
    await call(bob, 'add', { input: { label: 'x' } }, SECRETS);
    assert.equal(await stream.next(/event: change/, 150), null);
    assert.ok(await stream.next(/: ping\n\n/), 'kept alive');
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.deps.live.count('groceries'), 0);
  });

  it('renews the session on the event stream too, and only opens a stream for a GET', async () => {
    // A page left open reconnects its stream before anything else: that request slides the session.
    ctx.deps.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE scope = 'groceries'")
      .run(new Date(Date.now() - 3 * 3600 * 1000).toISOString());
    const stream = await events(bob);
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.getSetCookie().join('\n'), /^__Host-socle_app=[^;]+; Max-Age=2592000;/);
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (let attempt = 0; attempt < 10; attempt++) {
      const head = await bob.request(`${GROCERIES}/_socle/api/events`, {
        method: 'HEAD',
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(head.status, 405);
    }
    assert.equal(ctx.deps.live.count('groceries'), 0, 'no stream was opened for them');
  });

  it('closes the stream of someone who is no longer signed in, and bounds how many one member holds', async () => {
    const visitor = new Browser(ctx.app);
    const { family } = signIn(ctx, visitor, ALICE);
    await visitor.navigate(`${GROCERIES}/`);
    const streams = [];
    for (let index = 0; index < 8; index++) streams.push(await events(visitor));
    assert.equal(ctx.deps.live.count('groceries'), 8);
    const extra = await events(visitor);
    assert.equal(await extra.next(/retry: (\d+)\n\n/), '60000');
    assert.equal(await extra.next(/closed/), 'closed');
    for (const stream of streams.slice(1)) await stream.close();

    ctx.deps.db.prepare('DELETE FROM sessions WHERE family = ?').run(family);
    assert.equal(await streams[0]!.next(/closed/), 'closed');
    assert.equal(ctx.deps.live.count('groceries'), 0);
    assert.equal((await events(new Browser(ctx.app))).response.status, 401);
    assert.equal((await bob.fetch(`${GROCERIES}/_socle/api/events`, { pageOrigin: DEMO })).status, 403);
  });

  it('only replaces the published version when a new one builds and migrates', async () => {
    const stream = await events(bob);
    await stream.next(/retry/);
    const page = async () =>
      /\/assets\/[0-9a-f]{16}/.exec(await (await bob.navigate(`${GROCERIES}/`)).response.text())![0];
    const first = await page();

    const broken = await ctx.deps.apps.deploy(
      'groceries',
      groceries({ 'web/main.tsx': 'import x from "left-pad"; export default x;' }),
      null,
    );
    assert.ok(!broken.ok && broken.stage === 'build');
    assert.match(broken.problems[0]!.message, /"left-pad" is not available/);
    const badSql = await ctx.deps.apps.deploy(
      'groceries',
      groceries({ 'migrations/002_more.sql': 'CREATE TABLE items (again)' }),
      null,
    );
    assert.deepEqual(badSql, {
      ok: false,
      stage: 'migrate',
      problems: [{ file: 'migrations/002_more.sql', message: 'table items already exists' }],
    });
    assert.equal(await page(), first);
    assert.equal(await stream.next(/event: version/, 100), null);

    assert.deepEqual(await ctx.deps.apps.deploy('groceries', groceries(), null), {
      ok: true,
      versionId: 2,
      unchanged: true,
      applied: [],
    });

    const next = await ctx.deps.apps.deploy(
      'groceries',
      groceries({
        'app.json': '{ "name": "Groceries 2" }',
        'migrations/002_done.sql': 'ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
        'web/main.tsx': 'export default function App() { return <p className="p-8">v2</p>; }',
      }),
      { id: bobId },
    );
    assert.ok(next.ok && !next.unchanged);
    assert.deepEqual(next.applied, ['002_done.sql']);
    // Open pages are told to reload; one that has not yet still finds the files it was given.
    assert.ok(await stream.next(/event: version\ndata: \{\}\n\n/));
    const second = await page();
    assert.notEqual(second, first);
    assert.equal((await bob.request(`${GROCERIES}${first}/main.js`)).status, 200);
    assert.match(await (await bob.request(`${GROCERIES}${second}/style.css`)).text(), /\.p-8\{/);
    assert.match(await (await bob.navigate(`${GROCERIES}/`)).response.text(), /<title>Groceries 2<\/title>/);
    assert.ok(((await value(await call(bob, 'list'))) as unknown[]).length >= 3, 'the data is still there');
    await stream.close();
  });

  it('keeps the last versions only, and the colors of the version that is live', async () => {
    const count = () =>
      (ctx.deps.db.prepare("SELECT COUNT(*) AS n FROM app_versions WHERE app = 'palette'").get() as { n: number }).n;
    const colors = () =>
      ctx.deps.db.prepare("SELECT theme_color, background_color FROM apps WHERE slug = 'palette'").get();
    const publish = (index: number, manifest: object) =>
      ctx.deps.apps.publish(
        'palette',
        { 'app.json': JSON.stringify(manifest), 'web/main.tsx': `export default () => ${index};` },
        {
          manifest: { name: 'Palette', description: '', themeColor: null, backgroundColor: null, ...manifest },
          web: { js: `console.log(${index});`, css: '' },
          server: null,
          migrations: [],
        },
        null,
      );
    const first = publish(0, { themeColor: '#ff0000', backgroundColor: '#00ff00' });
    assert.deepEqual({ ...(colors() as object) }, { theme_color: '#ff0000', background_color: '#00ff00' });
    const firstAssets = ctx.deps.apps.live('palette')!.assetHash;
    let last = first;
    for (let index = 1; index <= 24; index++) last = publish(index, {});
    // A version that names no color gets the platform's, not the previous version's.
    assert.deepEqual({ ...(colors() as object) }, { theme_color: '#f4f1ea', background_color: '#f4f1ea' });
    assert.equal(count(), 20);
    assert.equal(ctx.deps.apps.live('palette')!.id, last);
    assert.equal(
      ctx.deps.apps.byAssetHash('palette', firstAssets, 'live'),
      null,
      'the oldest ones are gone, from memory too',
    );
    assert.ok(publish(25, {}) > last, 'and an id is never given twice');
  });

  it('publishes one deployment at a time per app', async () => {
    const version = (label: string) =>
      groceries({
        'app.json': '{ "name": "Groceries 2" }',
        'migrations/002_done.sql': 'ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
        'web/main.tsx': `export default function App() { return <p>${label}</p>; }`,
      });
    const outcomes = await Promise.all(
      ['a', 'b', 'c'].map((label) => ctx.deps.apps.deploy('groceries', version(label), null)),
    );
    const ids = outcomes.map((outcome) => (outcome.ok ? outcome.versionId : 0));
    assert.deepEqual(ids, [ids[0]!, ids[0]! + 1, ids[0]! + 2], 'in the order they were asked');
    const live = ctx.deps.apps.live('groceries')!;
    assert.equal(live.id, ids[2]);
    assert.match(new TextDecoder().decode(live.js), /children:"c"/);
  });

  it('has the runner copy each app’s data once a day', async () => {
    // groceries and secrets; the fake demo has no data
    assert.deepEqual(await backupApps(ctx.deps, '2027-01-15'), { written: 2, failed: [] });
    assert.deepEqual(await backupApps(ctx.deps, '2027-01-15'), { written: 0, failed: [] });
    const dir = path.join(ctx.deps.config.dataDir, 'apps', 'groceries', 'backups');
    assert.deepEqual(readdirSync(dir), ['live-2027-01-15.db']);
    const copy = new DatabaseSync(path.join(dir, 'live-2027-01-15.db'), { readOnly: true });
    assert.ok((copy.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n >= 3);
    copy.close();
    for (let day = 16; day <= 31; day++) await ctx.deps.runner.backup('groceries/live', `2027-01-${day}`, 14);
    assert.equal(readdirSync(dir).length, 14);
    assert.deepEqual(await ctx.deps.runner.backup('../x/live', '2027-01-15', 14), {
      ok: false,
      message: 'invalid database name: ../x/live',
    });
    assert.deepEqual(await ctx.deps.runner.backup('groceries/live', '../../x', 14), {
      ok: false,
      message: 'invalid backup date: ../../x',
    });

    // One app's copy being stopped (too slow, here) does not stop the others, and what was
    // left half-written is not taken for a backup the next time.
    const real = ctx.deps.runner.backup;
    ctx.deps.runner.backup = (database, date, keep) =>
      database === 'groceries/live'
        ? Promise.reject(new RunnerUnavailable('timeout', 'this took too long and was stopped'))
        : real(database, date, keep);
    try {
      assert.deepEqual(await backupApps(ctx.deps, '2027-02-01'), { written: 1, failed: ['groceries'] });
    } finally {
      ctx.deps.runner.backup = real;
    }
    writeFileSync(path.join(dir, 'live-2027-02-01.db.partial'), 'cut short');
    assert.deepEqual(await backupApps(ctx.deps, '2027-02-01'), { written: 1, failed: [] });
    assert.ok(readdirSync(dir).includes('live-2027-02-01.db'));
    assert.ok(!readdirSync(dir).some((entry) => entry.endsWith('.partial')));
  });

  it('gives each app its turn at the runner, and refuses a flood instead of queueing it', async () => {
    // One member's page of "groceries" fires a burst of calls that each hold a worker until stopped.
    const burst = Array.from({ length: 30 }, () => call(bob, 'spin'));
    let burstOver = false;
    const settled = Promise.all(burst).then((responses) => {
      burstOver = true;
      return responses;
    });
    // Meanwhile the other app answers: the stuck one never holds every worker, and the other
    // app's call does not wait behind its line.
    assert.deepEqual(await value(await call(bob, 'list', {}, SECRETS)), [{ label: 'code du coffre' }, { label: 'x' }]);
    assert.equal(burstOver, false, 'answered while the other app was still stuck');
    const statuses = (await settled).map((response) => response.status);
    // Two run at a time, sixteen wait their turn (and give up when it takes too long), the rest are refused at once.
    assert.equal(statuses.filter((status) => status === 503).length >= 12, true, JSON.stringify(statuses));
    assert.ok(
      statuses.every((status) => status === 503 || status === 504),
      JSON.stringify(statuses),
    );
    assert.ok(await value(await call(bob, 'context')), 'and the app answers again afterwards');
  });

  it('gives the runner an app’s code again when the runner lost it', async () => {
    const outcome = await ctx.deps.apps.deploy('perdu', groceries({ 'app.json': '{ "name": "Perdu" }' }), null);
    assert.ok(outcome.ok);
    await bob.navigate('https://perdu.apps.test/');
    const version = ctx.deps.apps.live('perdu')!;
    const bundles = path.join(ctx.deps.config.dataDir, 'apps', 'perdu', 'bundles');
    assert.deepEqual(readdirSync(bundles), [`${version.bundleHash}.js`]);
    // A runner that starts on a new disk, say: the code it was given at publication is gone.
    rmSync(bundles, { recursive: true });
    const direct = await ctx.deps.runner.call({
      database: 'perdu/live',
      bundleHash: version.bundleHash!,
      fn: 'list',
      inputJson: 'null',
      user: null,
      members: [],
      now: 0,
      today: '',
    });
    assert.ok(!direct.ok && direct.error.code === 'bundle_missing');
    assert.deepEqual(await value(await call(bob, 'list', {}, 'https://perdu.apps.test')), []);
    assert.deepEqual(readdirSync(bundles), [`${version.bundleHash}.js`], 'the web side sent it again');
  });

  it('says so when the runner is away, without failing the rest', async () => {
    const real = ctx.deps.runner.call;
    ctx.deps.runner.call = () => Promise.reject(new RunnerUnavailable('unreachable', 'the runner is not reachable'));
    try {
      const response = await call(bob, 'list');
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { error: string }).error, 'unavailable');
      assert.equal((await bob.fetch(`${GROCERIES}/_socle/api/me`)).status, 200);
    } finally {
      ctx.deps.runner.call = real;
    }
  });

  it('serves the platform’s own modules once for every app, revalidated by fingerprint', async () => {
    ctx.deps.vendor = new VendorCache(ctx.deps.runner);
    const anonymous = new Browser(ctx.app);
    for (const file of ['react.js', 'react-dom.js', 'react-jsx-runtime.js', 'sdk.js', 'ui.js', 'ui.css']) {
      const response = await anonymous.request(`${GROCERIES}/_socle/vendor/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const etag = response.headers.get('etag')!;
      assert.match(etag, /^"[0-9a-f]{20}"$/);
      const again = await anonymous.request(`${GROCERIES}/_socle/vendor/${file}`, {
        headers: { 'if-none-match': etag },
      });
      assert.equal(again.status, 304);
      assert.equal(await again.text(), '');
    }
    const ui = await (await anonymous.request(`${GROCERIES}/_socle/vendor/ui.js`)).text();
    assert.match(ui, /from"\/_socle\/vendor\/react\.js"/);
    assert.match(ui, /from"\/_socle\/vendor\/sdk\.js"/);
    const css = await (await anonymous.request(`${GROCERIES}/_socle/vendor/ui.css`)).text();
    assert.match(css, /--socle-bg:/);
    assert.match(css, /box-sizing/);
    assert.equal((await bob.request(`${GROCERIES}/_socle/vendor/../../package.json`)).status, 404);
    assert.equal((await bob.request(`${GROCERIES}/_socle/vendor/nope.js`)).status, 404);
  });

  it('ships a demo app that goes through the same build and sandbox', async () => {
    const outcome = await syncDemoApp(ctx.deps.db, ctx.deps.apps, true);
    assert.ok(outcome?.ok, JSON.stringify(outcome));
    assert.deepEqual(outcome.applied, ['001_init.sql', '002_photo.sql']);
    await bob.navigate(`${DEMO}/`);
    ctx.push.sent.length = 0;
    const added = await value(await call(bob, 'add', { input: { label: '  Du pain ' } }, DEMO));
    assert.deepEqual(added, { id: 1 });
    assert.deepEqual(await value(await call(bob, 'list', { query: true }, DEMO)), [
      { id: 1, label: 'Du pain', done: 0, author: bobId, photo: null },
    ]);
    assert.equal(await value(await call(bob, 'toggle', { input: { id: 1 } }, DEMO)), 1);
    assert.equal((await call(bob, 'add', { input: { label: '   ' } }, DEMO)).status, 422);
    assert.equal(await value(await call(bob, 'remove', { input: { id: 1 } }, DEMO)), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      ctx.push.sent.map((sent) => [sent.userId, sent.app, sent.message.title]),
      [[aliceId, DEMO_SLUG, 'bob added “Du pain”']],
    );
    // Turning the demo off removes the app; its sources come back with the next start.
    assert.equal(await syncDemoApp(ctx.deps.db, ctx.deps.apps, false), null);
    assert.equal((await bob.navigate(`${DEMO}/`)).response.status, 404);
  });
});

describe('an instance set to another language', () => {
  it('speaks it on its own pages, and tells the apps which one it is', async () => {
    const ctx = setup({ limits: TEST_LIMITS, env: { APP_LOCALE: 'fr' } });
    try {
      const anonymous = new Browser(ctx.app);
      assert.match(await (await anonymous.request(`${CONTROL}/`)).text(), /<html lang="fr">[\s\S]*Se connecter/);
      const outcome = await syncDemoApp(ctx.deps.db, ctx.deps.apps, true, 'fr');
      assert.ok(outcome?.ok, JSON.stringify(outcome));
      const bob = new Browser(ctx.app);
      signIn(ctx, bob, BOB);
      const page = await (await bob.navigate(`${DEMO}/`)).response.text();
      assert.match(page, /<html lang="fr">/);
      assert.match(page, /<title>Démo<\/title>/);
      assert.match(page, /"locale":"fr"/);
      // The demo's server functions answer in the language their context names.
      const refused = await bob.fetch(`${DEMO}/_socle/api/fn/add`, {
        method: 'POST',
        json: { input: { label: '   ' } },
      });
      assert.equal(refused.status, 422);
      assert.equal(((await refused.json()) as { message: string }).message, 'Écrivez quelque chose à ajouter.');
      // So does the platform when it refuses an input the function does not accept.
      const invalid = await bob.fetch(`${DEMO}/_socle/api/fn/add`, { method: 'POST', json: { input: { label: '' } } });
      assert.equal(invalid.status, 400);
      assert.equal(((await invalid.json()) as { message: string }).message, 'input.label: ne doit pas être vide');
    } finally {
      ctx.cleanup();
    }
  });
});
