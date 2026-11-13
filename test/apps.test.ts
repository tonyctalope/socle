import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { VendorCache } from '../src/apphost/vendor.ts';
import { DEMO_SLUG, syncDemoApp } from '../src/apps/demo.ts';
import { backupApps } from '../src/jobs.ts';
import { RunnerUnavailable } from '../src/runner/client.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { Browser, CHLOE, DEMO, setup, signIn, TONY, type TestContext } from './helpers.ts';

// Apps end to end, as browsers see them: sources go in, the runner builds them, and
// pages call the app's server functions through the platform.

const COURSES = 'https://courses.apps.test';
const SECRETS = 'https://secrets.apps.test';

const courses = (extra: Record<string, string> = {}) => ({
  'app.json': JSON.stringify({ name: 'Courses', description: 'La liste de la maison', themeColor: '#2F5D8A' }),
  'web/main.tsx': `
    import { useQuery } from '@socle/sdk';
    import { Page } from '@socle/ui';
    export default function App() {
      const items = useQuery('list');
      return <Page title="Courses"><p className="text-brand md:p-4">{JSON.stringify(items.data)}</p></Page>;
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
        if (label === 'interdit') fail('Pas ça.', 'forbidden_item');
        if (label === 'bug') return undefinedVariable;
        const { lastInsertRowid } = db.run('INSERT INTO items (label, author) VALUES (?, ?)', label, user.id);
        notify('others', { title: user.name + ' a ajouté ' + label, url: '/item/' + lastInsertRowid });
        notify([user.id, 999], { title: 'Ajouté', body: label });
        return lastInsertRowid;
      },
    });
    export const noisy = query(() => { console.log('hello from the app'); return 1; });
    export const spin = query(() => { for (;;) {} });
  `,
  ...extra,
});

describe('an app, from its sources to the browser', () => {
  let ctx: TestContext;
  let tony: Browser;
  let chloe: Browser;
  let tonyId: number;
  let chloeId: number;

  before(async () => {
    ctx = setup({ limits: { ...DEFAULT_LIMITS, callMs: 400, killGraceMs: 300 } });
    ctx.deps.streamPingMs = 40;
    tony = new Browser(ctx.app);
    chloe = new Browser(ctx.app);
    tonyId = signIn(ctx, tony, TONY).userId;
    chloeId = signIn(ctx, chloe, CHLOE).userId;
    assert.deepEqual(await ctx.deps.apps.deploy('courses', courses(), { id: tonyId }), {
      ok: true,
      versionId: 2,
      unchanged: false,
      applied: ['001_init.sql'],
    });
    await tony.navigate(`${COURSES}/`);
    await chloe.navigate(`${COURSES}/`);
  });
  after(() => ctx.cleanup());

  const call = (browser: Browser, name: string, body: unknown = {}, origin = COURSES) =>
    browser.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: body });
  const value = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { value: unknown }).value;
  };

  it('serves a page written by the platform around the built app', async () => {
    const { response } = await tony.navigate(`${COURSES}/liste?x=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.text();
    assert.match(page, /<title>Courses<\/title>/);
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
    assert.deepEqual(boot.user, { id: tonyId, name: 'tony' });
    assert.deepEqual(boot.members, [
      { id: tonyId, name: 'tony' },
      { id: chloeId, name: 'chloe' },
    ]);
    assert.deepEqual(boot.app, { slug: 'courses', name: 'Courses' });
    assert.equal(boot.push.publicKey, ctx.push.publicKey);
    assert.doesNotMatch(page, /@example\./);

    const js = await (await tony.request(`${COURSES}${script}`)).text();
    assert.match(js, /from"\/_socle\/vendor\/sdk\.js"/);
    assert.doesNotMatch(js, /node_modules|createElement\(/, 'React is not bundled into the app');
    const css = await (await tony.request(`${COURSES}${script.replace('main.js', 'style.css')}`)).text();
    assert.match(css, /\.text-brand\{color:var\(--color-brand\)\}/);
    assert.match(css, /--color-brand: ?#0a7a3d/);
    assert.doesNotMatch(css, /box-sizing/, 'base styles come once, from the platform stylesheet');
  });

  it('cannot break out of the page through a name', async () => {
    const hostile = '</script><script>alert(1)</script><!--';
    ctx.deps.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(hostile, chloeId);
    try {
      const page = await (await tony.navigate(`${COURSES}/`)).response.text();
      assert.equal((page.match(/<script/g) ?? []).length, 2);
      assert.doesNotMatch(page, /alert\(1\)<\/script>/);
      const boot = JSON.parse(
        /<script id="socle-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page)![1]!,
      ) as {
        members: { name: string }[];
      };
      assert.equal(boot.members[1]!.name, hostile);
    } finally {
      ctx.deps.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('chloe', chloeId);
    }
  });

  it('runs the app’s functions for signed-in members, with who they are', async () => {
    assert.deepEqual(await value(await call(tony, 'list')), []);
    assert.equal(await value(await call(tony, 'add', { input: { label: 'Pain' } })), 1);
    assert.equal(await value(await call(chloe, 'add', { input: { label: 'Lait' } })), 2);
    assert.deepEqual(await value(await call(chloe, 'list', { query: true })), [
      { id: 1, label: 'Pain', author: tonyId },
      { id: 2, label: 'Lait', author: chloeId },
    ]);
    ctx.clock.now = new Date('2027-01-15T23:30:00Z'); // already the 16th in Paris
    assert.deepEqual(await value(await call(chloe, 'context')), {
      user: { id: chloeId, name: 'chloe' },
      members: [
        { id: tonyId, name: 'tony' },
        { id: chloeId, name: 'chloe' },
      ],
      now: Date.parse('2027-01-15T23:30:00Z'),
      today: '2027-01-16',
    });
    ctx.clock.now = new Date();
  });

  it('answers failures in a way the page can show', async () => {
    const problem = async (response: Response) => ({ status: response.status, ...((await response.json()) as object) });
    assert.deepEqual(await problem(await call(tony, 'add', { input: { label: '' } })), {
      status: 400,
      error: 'invalid_input',
      message: 'input.label: must not be empty',
    });
    assert.deepEqual(await problem(await call(tony, 'add', { input: { label: 'interdit' } })), {
      status: 422,
      error: 'forbidden_item',
      message: 'Pas ça.',
    });
    // A bug of the app says nothing about its insides to the browser.
    assert.deepEqual(await problem(await call(tony, 'add', { input: { label: 'bug' } })), {
      status: 500,
      error: 'app_error',
      message: 'L’appli a rencontré une erreur.',
    });
    assert.deepEqual(await problem(await call(tony, 'spin')), {
      status: 504,
      error: 'timeout',
      message: 'L’appli a mis trop de temps à répondre.',
    });
    assert.equal((await call(tony, 'nope')).status, 404);
    assert.equal((await call(tony, 'toString')).status, 404);
    assert.equal((await call(tony, 'add', 'not an object')).status, 400);
    assert.equal((await tony.request(`${COURSES}/_socle/api/fn/add`, { method: 'POST', body: '{}' })).status, 403);
    // A screen that only reads never writes by accident.
    const mistaken = await call(tony, 'add', { query: true, input: { label: 'Fantôme' } });
    assert.deepEqual(await problem(mistaken), {
      status: 400,
      error: 'not_a_query',
      message: 'add modifie des données : appelle-la avec api.add().',
    });
    assert.equal(((await value(await call(tony, 'list'))) as unknown[]).length, 2);
  });

  it('refuses calls that do not come from the app’s own pages', async () => {
    const before = ((await value(await call(tony, 'list'))) as unknown[]).length;
    const url = `${COURSES}/_socle/api/fn/add`;
    const json = { input: { label: 'Intrus' } };
    // A page of another app, of the control plane, or of anywhere else, with Tony's cookies attached.
    for (const pageOrigin of [DEMO, 'https://socle.test', 'https://evil.example']) {
      assert.equal((await tony.fetch(url, { method: 'POST', json, pageOrigin })).status, 403, pageOrigin);
    }
    assert.equal((await tony.request(url, { method: 'POST', body: JSON.stringify(json) })).status, 403, 'no Origin');
    assert.equal((await tony.fetch(url, { method: 'GET' })).status, 404);
    assert.equal((await new Browser(ctx.app).fetch(url, { method: 'POST', json })).status, 401);
    // A session of another app is worth nothing here.
    const elsewhere = new Browser(ctx.app);
    signIn(ctx, elsewhere, TONY);
    await elsewhere.navigate(`${DEMO}/`);
    elsewhere.setCookie(COURSES, '__Host-socle_app', elsewhere.cookie(DEMO, '__Host-socle_app')!);
    assert.equal((await elsewhere.fetch(url, { method: 'POST', json })).status, 401);
    assert.equal(((await value(await call(tony, 'list'))) as unknown[]).length, before);
  });

  it('keeps each app’s data to itself', async () => {
    const outcome = await ctx.deps.apps.deploy(
      'secrets',
      courses({
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
    await tony.navigate(`${SECRETS}/`);
    assert.equal(await value(await call(tony, 'add', { input: { label: 'code du coffre' } }, SECRETS)), 1);
    assert.deepEqual(await value(await call(tony, 'list', {}, SECRETS)), [{ label: 'code du coffre' }]);
    const labels = ((await value(await call(tony, 'list'))) as { label: string }[]).map((item) => item.label);
    assert.ok(!labels.includes('code du coffre'));
    // The function exists in one app only, and that app cannot name the other's database.
    assert.equal((await call(tony, 'steal', { input: { sql: 'SELECT 1' } })).status, 404);
    for (const sql of [
      "ATTACH 'courses/live.db' AS c",
      'SELECT * FROM courses.items',
      'SELECT * FROM pragma_database_list',
    ]) {
      assert.equal((await call(tony, 'steal', { input: { sql } }, SECRETS)).status, 500, sql);
    }
  });

  it('sends the notifications a mutation asked for, to members of the app only', async () => {
    ctx.push.sent.length = 0;
    const id = await value(await call(tony, 'add', { input: { label: 'Œufs' } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      ctx.push.sent.map((sent) => ({ ...sent, message: { ...sent.message, tag: undefined } })),
      [
        {
          userId: chloeId,
          app: 'courses',
          message: { title: 'tony a ajouté Œufs', body: '', url: `/item/${id}`, tag: undefined },
        },
        // 999 is nobody: dropped.
        { userId: tonyId, app: 'courses', message: { title: 'Ajouté', body: 'Œufs', url: '/', tag: undefined } },
      ],
    );
    // A call that fails notifies nobody.
    ctx.push.sent.length = 0;
    await call(tony, 'add', { input: { label: 'interdit' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.push.sent.length, 0);
  });

  /** Opens the event stream of a page and returns a way to wait for its next event. */
  async function events(browser: Browser, origin = COURSES) {
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
    const stream = await events(chloe);
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get('content-type')!, /^text\/event-stream/);
    assert.match(stream.response.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.equal(await stream.next(/retry: (\d+)\n\n/), '3000');
    assert.equal(ctx.deps.live.count('courses'), 1);

    // Tony changes something from a page that names itself: Chloé's page hears about it.
    await tony.fetch(`${COURSES}/_socle/api/fn/add`, {
      method: 'POST',
      json: { input: { label: 'Beurre' } },
      headers: { 'x-socle-client': 'tab1' },
    });
    assert.equal(await stream.next(/event: change\ndata: (.*)\n\n/), '{"client":"tab1"}');
    // Reading changes nothing, a refused call neither, and another app's changes are not hers to hear.
    await call(tony, 'list');
    await call(tony, 'add', { input: { label: 'interdit' } });
    await call(tony, 'add', { input: { label: 'x' } }, SECRETS);
    assert.equal(await stream.next(/event: change/, 150), null);
    assert.ok(await stream.next(/: ping\n\n/), 'kept alive');
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ctx.deps.live.count('courses'), 0);
  });

  it('closes the stream of someone who is no longer signed in, and bounds how many one member holds', async () => {
    const visitor = new Browser(ctx.app);
    const { family } = signIn(ctx, visitor, CHLOE);
    await visitor.navigate(`${COURSES}/`);
    const streams = [];
    for (let index = 0; index < 8; index++) streams.push(await events(visitor));
    assert.equal(ctx.deps.live.count('courses'), 8);
    const extra = await events(visitor);
    assert.equal(await extra.next(/retry: (\d+)\n\n/), '60000');
    assert.equal(await extra.next(/closed/), 'closed');
    for (const stream of streams.slice(1)) await stream.close();

    ctx.deps.db.prepare('DELETE FROM sessions WHERE family = ?').run(family);
    assert.equal(await streams[0]!.next(/closed/), 'closed');
    assert.equal(ctx.deps.live.count('courses'), 0);
    assert.equal((await events(new Browser(ctx.app))).response.status, 401);
    assert.equal((await tony.fetch(`${COURSES}/_socle/api/events`, { pageOrigin: DEMO })).status, 403);
  });

  it('only replaces the published version when a new one builds and migrates', async () => {
    const stream = await events(tony);
    await stream.next(/retry/);
    const page = async () =>
      /\/assets\/[0-9a-f]{16}/.exec(await (await tony.navigate(`${COURSES}/`)).response.text())![0];
    const first = await page();

    const broken = await ctx.deps.apps.deploy(
      'courses',
      courses({ 'web/main.tsx': 'import x from "left-pad"; export default x;' }),
      null,
    );
    assert.ok(!broken.ok && broken.stage === 'build');
    assert.match(broken.problems[0]!.message, /"left-pad" is not available/);
    const badSql = await ctx.deps.apps.deploy(
      'courses',
      courses({ 'migrations/002_more.sql': 'CREATE TABLE items (again)' }),
      null,
    );
    assert.deepEqual(badSql, {
      ok: false,
      stage: 'migrate',
      problems: [{ file: 'migrations/002_more.sql', message: 'table items already exists' }],
    });
    assert.equal(await page(), first);
    assert.equal(await stream.next(/event: version/, 100), null);

    assert.deepEqual(await ctx.deps.apps.deploy('courses', courses(), null), {
      ok: true,
      versionId: 2,
      unchanged: true,
      applied: [],
    });

    const next = await ctx.deps.apps.deploy(
      'courses',
      courses({
        'app.json': '{ "name": "Courses 2" }',
        'migrations/002_done.sql': 'ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
        'web/main.tsx': 'export default function App() { return <p className="p-8">v2</p>; }',
      }),
      { id: tonyId },
    );
    assert.ok(next.ok && !next.unchanged);
    assert.deepEqual(next.applied, ['002_done.sql']);
    // Open pages are told to reload; one that has not yet still finds the files it was given.
    assert.ok(await stream.next(/event: version\ndata: \{\}\n\n/));
    const second = await page();
    assert.notEqual(second, first);
    assert.equal((await tony.request(`${COURSES}${first}/main.js`)).status, 200);
    assert.match(await (await tony.request(`${COURSES}${second}/style.css`)).text(), /\.p-8\{/);
    assert.match(await (await tony.navigate(`${COURSES}/`)).response.text(), /<title>Courses 2<\/title>/);
    assert.ok(((await value(await call(tony, 'list'))) as unknown[]).length >= 3, 'the data is still there');
    await stream.close();
  });

  it('publishes one deployment at a time per app', async () => {
    const version = (label: string) =>
      courses({
        'app.json': '{ "name": "Courses 2" }',
        'migrations/002_done.sql': 'ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
        'web/main.tsx': `export default function App() { return <p>${label}</p>; }`,
      });
    const outcomes = await Promise.all(
      ['a', 'b', 'c'].map((label) => ctx.deps.apps.deploy('courses', version(label), null)),
    );
    const ids = outcomes.map((outcome) => (outcome.ok ? outcome.versionId : 0));
    assert.deepEqual(ids, [ids[0]!, ids[0]! + 1, ids[0]! + 2], 'in the order they were asked');
    const live = ctx.deps.apps.live('courses')!;
    assert.equal(live.id, ids[2]);
    assert.match(new TextDecoder().decode(live.js), /children:"c"/);
  });

  it('has the runner copy each app’s data once a day', async () => {
    assert.equal(await backupApps(ctx.deps, '2027-01-15'), 2); // courses and secrets; the fake demo has no data
    assert.equal(await backupApps(ctx.deps, '2027-01-15'), 0);
    const dir = path.join(ctx.deps.config.dataDir, 'apps', 'courses', 'backups');
    assert.deepEqual(readdirSync(dir), ['live-2027-01-15.db']);
    const copy = new DatabaseSync(path.join(dir, 'live-2027-01-15.db'), { readOnly: true });
    assert.ok((copy.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n >= 3);
    copy.close();
    for (let day = 16; day <= 31; day++) await ctx.deps.runner.backup('courses/live', `2027-01-${day}`, 14);
    assert.equal(readdirSync(dir).length, 14);
    assert.deepEqual(await ctx.deps.runner.backup('../x/live', '2027-01-15', 14), {
      ok: false,
      message: 'invalid database name: ../x/live',
    });
    assert.deepEqual(await ctx.deps.runner.backup('courses/live', '../../x', 14), {
      ok: false,
      message: 'invalid backup date: ../../x',
    });
  });

  it('says so when the runner is away, without failing the rest', async () => {
    const real = ctx.deps.runner.call;
    ctx.deps.runner.call = () => Promise.reject(new RunnerUnavailable('unreachable', 'the runner is not reachable'));
    try {
      const response = await call(tony, 'list');
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { error: string }).error, 'unavailable');
      assert.equal((await tony.fetch(`${COURSES}/_socle/api/me`)).status, 200);
    } finally {
      ctx.deps.runner.call = real;
    }
  });

  it('serves the platform’s own modules once for every app, revalidated by fingerprint', async () => {
    ctx.deps.vendor = new VendorCache(ctx.deps.runner);
    const anonymous = new Browser(ctx.app);
    for (const file of ['react.js', 'react-dom.js', 'react-jsx-runtime.js', 'sdk.js', 'ui.js', 'ui.css']) {
      const response = await anonymous.request(`${COURSES}/_socle/vendor/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const etag = response.headers.get('etag')!;
      assert.match(etag, /^"[0-9a-f]{20}"$/);
      const again = await anonymous.request(`${COURSES}/_socle/vendor/${file}`, { headers: { 'if-none-match': etag } });
      assert.equal(again.status, 304);
      assert.equal(await again.text(), '');
    }
    const ui = await (await anonymous.request(`${COURSES}/_socle/vendor/ui.js`)).text();
    assert.match(ui, /from"\/_socle\/vendor\/react\.js"/);
    assert.match(ui, /from"\/_socle\/vendor\/sdk\.js"/);
    const css = await (await anonymous.request(`${COURSES}/_socle/vendor/ui.css`)).text();
    assert.match(css, /--socle-bg:/);
    assert.match(css, /box-sizing/);
    assert.equal((await tony.request(`${COURSES}/_socle/vendor/../../package.json`)).status, 404);
    assert.equal((await tony.request(`${COURSES}/_socle/vendor/nope.js`)).status, 404);
  });

  it('ships a demo app that goes through the same build and sandbox', async () => {
    const outcome = await syncDemoApp(ctx.deps.db, ctx.deps.apps, true);
    assert.ok(outcome?.ok, JSON.stringify(outcome));
    assert.deepEqual(outcome.applied, ['001_init.sql']);
    await tony.navigate(`${DEMO}/`);
    ctx.push.sent.length = 0;
    const added = await value(await call(tony, 'add', { input: { label: '  Du pain ' } }, DEMO));
    assert.deepEqual(added, { id: 1 });
    assert.deepEqual(await value(await call(tony, 'list', { query: true }, DEMO)), [
      { id: 1, label: 'Du pain', done: 0, author: tonyId },
    ]);
    assert.equal(await value(await call(tony, 'toggle', { input: { id: 1 } }, DEMO)), 1);
    assert.equal((await call(tony, 'add', { input: { label: '   ' } }, DEMO)).status, 422);
    assert.equal(await value(await call(tony, 'remove', { input: { id: 1 } }, DEMO)), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      ctx.push.sent.map((sent) => [sent.userId, sent.app, sent.message.title]),
      [[chloeId, DEMO_SLUG, 'tony a ajouté « Du pain »']],
    );
    // Turning the demo off removes the app; its sources come back with the next start.
    assert.equal(await syncDemoApp(ctx.deps.db, ctx.deps.apps, false), null);
    assert.equal((await tony.navigate(`${DEMO}/`)).response.status, 404);
  });
});
