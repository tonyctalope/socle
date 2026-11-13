import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { functionCaller } from '../src/apphost/calls.ts';
import { CallGate } from '../src/apphost/gate.ts';
import { getApp } from '../src/apps/registry.ts';
import { siteOf } from '../src/apps/slug.ts';
import { all } from '../src/db/database.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, Browser, CONTROL, setup, signIn, subscription, type TestContext } from './helpers.ts';

// The rules an independent review of drafts and of the builder asked to be pinned: what the
// two addresses of an app must not share, and what the operations on a draft must leave
// consistent when they overlap or fail.

const LIVE = 'https://tasks.apps.test';
const DRAFT = 'https://tasks--draft.apps.test';
const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 };
const NAVIGATION = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const INIT = 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL);';
const DONE = 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;';

/** An app whose every version says which one it is: in its page, in what it stores, in what it notifies. */
const tasks = (mark: string, extra: Record<string, string> = {}) => ({
  'app.json': JSON.stringify({ name: 'Tasks' }),
  'web/main.tsx': `export default function App() { return <p>${mark}</p>; }`,
  'migrations/001_init.sql': INIT,
  'server/index.ts': `
    import { mutation, query } from '@socle/server';
    export const list = query(({ db }) => db.all('SELECT label FROM tasks ORDER BY id'));
    export const add = mutation(({ db, notify }) => {
      notify('all', { title: '${mark}' });
      return db.run("INSERT INTO tasks (label) VALUES ('${mark}')").changes;
    });
  `,
  ...extra,
});

describe('the two addresses of an app share nothing', () => {
  let ctx: TestContext;
  let bob: Browser;

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS });
    bob = new Browser(ctx.app);
    const { userId } = signIn(ctx, bob, BOB);
    ctx.deps.apps.create('tasks', { name: 'Tasks', description: '' }, { id: userId });
    assert.ok((await ctx.deps.apps.saveDraft('tasks', tasks('one'), { id: userId })).ok);
    assert.ok((await ctx.deps.apps.publishDraft('tasks', ctx.deps.apps.status('tasks')!.draft.versionId)).ok);
    assert.ok((await ctx.deps.apps.saveDraft('tasks', tasks('two'), { id: userId })).ok);
  });
  after(() => ctx.cleanup());

  const call = (origin: string, name: string) =>
    bob.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: { input: null } });
  const value = async (response: Response) => ((await response.json()) as { value: unknown }).value;

  it('refuses on one address the sign-on code issued for the other', async () => {
    const start = await bob.request(`${DRAFT}/_socle/login?next=%2F`, { headers: NAVIGATION });
    const toControl = start.headers.get('location')!;
    assert.match(toControl, /app=tasks--draft/);
    const state = bob.cookie(DRAFT, '__Host-socle_sso')!;
    const back = await bob.request(toControl, { headers: NAVIGATION });
    const target = new URL(back.headers.get('location')!);
    assert.equal(target.origin, DRAFT);
    const other = new Browser(ctx.app);
    other.setCookie(LIVE, '__Host-socle_sso', state);
    const wrong = await other.request(`${LIVE}/_socle/sso?code=${target.searchParams.get('code')}`, {
      headers: NAVIGATION,
    });
    assert.equal(wrong.status, 400);
    assert.equal(other.cookie(LIVE, '__Host-socle_app'), undefined);
    assert.equal((await bob.request(target.href, { headers: NAVIGATION })).status, 400); // and the attempt burnt it
  });

  it('files notifications, functions and data under one address each', async () => {
    await bob.navigate(`${DRAFT}/`);
    await bob.navigate(`${LIVE}/`);
    const subscribed = await bob.fetch(`${DRAFT}/_socle/api/push/subscriptions`, {
      method: 'POST',
      json: subscription(),
    });
    assert.equal(subscribed.status, 204);
    const subscriptions = async (origin: string) =>
      ((await (await bob.fetch(`${origin}/_socle/api/me`)).json()) as { push: { subscriptions: number } }).push
        .subscriptions;
    assert.equal(await subscriptions(DRAFT), 1);
    assert.equal(await subscriptions(LIVE), 0);

    const sentBefore = ctx.push.sent.length;
    assert.equal((await call(LIVE, 'add')).status, 200);
    assert.equal((await call(DRAFT, 'add')).status, 200);
    assert.equal((await call(DRAFT, 'add')).status, 200);
    const sent = ctx.push.sent.slice(sentBefore).map((entry) => `${entry.app}:${entry.message.title}`);
    assert.deepEqual([...new Set(sent)].sort(), ['tasks--draft:two', 'tasks:one']);
    assert.deepEqual(await value(await call(LIVE, 'list')), [{ label: 'one' }]);
    assert.deepEqual(await value(await call(DRAFT, 'list')), [{ label: 'two' }, { label: 'two' }]);
    assert.deepEqual(
      all<{ app: string }>(ctx.deps.db, 'SELECT DISTINCT app FROM push_subscriptions').map((row) => row.app),
      ['tasks--draft'],
    );
  });

  it('announces a change on the address it happened on, and on no other', async () => {
    const stream = await bob.fetch(`${DRAFT}/_socle/api/events`);
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) return;
        seen.push(new TextDecoder().decode(chunk));
      }
    })();
    await call(LIVE, 'add');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!seen.join('').includes('event: change'), 'a published change reached the draft’s pages');
    await call(DRAFT, 'add');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(seen.join('').includes('event: change'));
    await reader.cancel();
    await pump.catch(() => {});
  });

  it('serves each address its own build files only', async () => {
    const live = ctx.deps.apps.live('tasks')!;
    const draft = ctx.deps.apps.draft('tasks')!;
    assert.notEqual(live.assetHash, draft.assetHash);
    const file = (origin: string, hash: string) => bob.request(`${origin}/assets/${hash}/main.js`);
    assert.equal((await file(LIVE, live.assetHash)).status, 200);
    assert.equal((await file(DRAFT, draft.assetHash)).status, 200);
    // Code no administrator published is not handed out by the published origin, even by its hash.
    assert.equal((await file(LIVE, draft.assetHash)).status, 404);
    assert.equal((await file(DRAFT, live.assetHash)).status, 404);
  });

  it('shows on the draft address the name and colors the draft gives the app', async () => {
    const renamed = tasks('two', { 'app.json': JSON.stringify({ name: 'Chores', themeColor: '#112233' }) });
    assert.ok((await ctx.deps.apps.saveDraft('tasks', renamed, null)).ok);
    const manifest = async (origin: string) =>
      (await (await bob.request(`${origin}/_socle/manifest.webmanifest`)).json()) as {
        name: string;
        theme_color: string;
      };
    assert.deepEqual(await manifest(DRAFT), {
      ...(await manifest(DRAFT)),
      name: 'Chores (draft)',
      theme_color: '#112233',
    });
    assert.equal((await manifest(LIVE)).name, 'Tasks');
    assert.match(await (await bob.navigate(`${DRAFT}/`)).response.text(), /<title>Chores \(draft\)<\/title>/);
    assert.match(await (await bob.navigate(`${LIVE}/`)).response.text(), /<title>Tasks<\/title>/);
  });

  it('counts the notifications a member gets once, whichever way the function was called', async () => {
    // Screens, the builder's call_function and an app's own tools all go through one caller.
    const callFunction = functionCaller(ctx.deps);
    assert.equal(functionCaller(ctx.deps), callFunction);
    const app = getApp(ctx.deps.db, 'tasks')!;
    const version = ctx.deps.apps.draft('tasks')!;
    const bobUser = all<{ id: number }>(ctx.deps.db, 'SELECT id FROM users ORDER BY id')[0]!;
    const before = ctx.push.sent.length;
    for (let index = 0; index < 40; index++) {
      const result = await callFunction({
        app,
        site: siteOf('tasks', true),
        version,
        info: version.functions.get('add')!,
        inputJson: 'null',
        caller: { id: bobUser.id, name: 'bob' },
      });
      assert.ok(typeof result === 'object' && result.ok);
    }
    assert.ok(ctx.push.sent.length - before <= 30, `${ctx.push.sent.length - before} notifications in a minute`);
  });

  it('gives an app one share of the runner for both addresses, and its draft a single place of it', async () => {
    const gate = new CallGate();
    let running = 0;
    let most = 0;
    const task = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return 'done' as const;
    };
    const published = [1, 2, 3].map(() => gate.run('tasks', undefined, task));
    const draft = [1, 2, 3].map(() => gate.run('tasks', undefined, task, 1));
    const outcomes = await Promise.all([...published, ...draft]);
    assert.ok(most <= 2, `${most} calls of one app ran at once`);
    assert.deepEqual(outcomes.slice(0, 3), ['done', 'done', 'done']);
    // One of the draft's calls waits for a place; the others are told the app is busy.
    assert.deepEqual(outcomes.slice(3).sort(), ['busy', 'busy', 'done']);
  });
});

describe('operations on a draft, when they overlap or fail', () => {
  let ctx: TestContext;
  let bobId: number;
  const apps = () => ctx.deps.apps;
  const migrations = (...names: string[]) =>
    names.map((name) => ({ name, sql: name === '001_init.sql' ? INIT : DONE }));
  const withDone = (mark: string) => tasks(mark, { 'migrations/002_done.sql': DONE });

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS });
    bobId = signIn(ctx, new Browser(ctx.app), BOB).userId;
    apps().create('tasks', { name: 'Tasks', description: '' }, { id: bobId });
    assert.ok((await apps().saveDraft('tasks', tasks('one'), { id: bobId })).ok);
    assert.ok((await apps().publishDraft('tasks', apps().status('tasks')!.draft.versionId)).ok);
  });
  after(() => ctx.cleanup());

  it('does not keep files of the wrong shape, even when the save is refused', async () => {
    const before = apps().files('tasks', 'draft');
    const weird = {
      ...tasks('two'),
      '../../outside.txt': 'x',
      ['a'.repeat(5000)]: 'y',
      'web/big.ts': 'z'.repeat(4 * 1024 * 1024),
    };
    const refused = await apps().saveDraft('tasks', weird, { id: bobId });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.stage, 'refused');
    assert.deepEqual(apps().files('tasks', 'draft'), before);
    const many: Record<string, string> = { ...tasks('two') };
    for (let index = 0; index < 1000; index++) many[`web/f${index}.ts`] = 'export {};';
    assert.equal((await apps().saveDraft('tasks', many, { id: bobId })).ok, false);
    assert.deepEqual(apps().files('tasks', 'draft'), before);
    // A path that is a property of every object is a path like another: refused, not swallowed.
    const proto = await apps().editDraft('tasks', { set: { ['__proto__']: 'x' } }, { id: bobId });
    assert.equal(proto.ok, false);
    assert.deepEqual(apps().files('tasks', 'draft'), before);
  });

  it('discards the draft that was shown, not one saved since', async () => {
    const shown = apps().status('tasks')!.draft.updatedAt; // what the administration page showed
    const saving = apps().saveDraft('tasks', tasks('three'), { id: bobId });
    const discarding = apps().discardDraft('tasks', shown); // asked while the build runs: it takes its turn after it
    assert.ok((await saving).ok);
    // Somebody's newer work is not thrown away in place of what the administrator looked at.
    const refused = await discarding;
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused), /the draft changed since it was shown/);
    assert.deepEqual(apps().files('tasks', 'draft'), tasks('three'));
    // Discarded for good once it is the one that was looked at.
    assert.ok((await apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt)).ok);
    const status = apps().status('tasks')!;
    assert.equal(status.draft.differs, false);
    assert.equal(status.draft.versionId, status.live?.versionId);
    assert.deepEqual(apps().files('tasks', 'draft'), tasks('one'));
  });

  it('brings the draft’s database back to the published schema when a draft is discarded', async () => {
    assert.ok((await apps().saveDraft('tasks', withDone('two'), { id: bobId })).ok);
    assert.ok((await apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt)).ok);
    // Nothing of the discarded draft's schema is left for the next draft to build on by accident.
    assert.deepEqual(await ctx.deps.runner.migrate('tasks/draft', migrations('001_init.sql')), {
      ok: true,
      applied: [],
      unknown: [],
    });
    // The same migration name can be used again, with other SQL.
    const other = tasks('two', { 'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN note TEXT;' });
    assert.ok((await apps().saveDraft('tasks', other, { id: bobId })).ok);
    assert.ok((await apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt)).ok);
  });

  it('keeps the published database and the published version in step when a discard meets a publication', async () => {
    assert.ok((await apps().saveDraft('tasks', withDone('two'), { id: bobId })).ok);
    const publishing = apps().publishDraft('tasks', apps().status('tasks')!.draft.versionId);
    const discarding = apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt);
    const published = await publishing;
    assert.ok(published.ok, JSON.stringify(published));
    // The discard took its turn after the publication: the draft it named is published, there is nothing to discard.
    assert.equal((await discarding).ok, false);
    const status = apps().status('tasks')!;
    assert.equal(status.draft.differs, false);
    assert.equal(status.live?.versionId, published.versionId);
    // The published database has exactly the migrations of the published version.
    assert.deepEqual(await ctx.deps.runner.migrate('tasks/live', migrations('001_init.sql', '002_done.sql')), {
      ok: true,
      applied: [],
      unknown: [],
    });
  });

  it('empties a draft database and migrates it again as one step', async () => {
    apps().create('gamma', { name: 'Gamma', description: '' }, { id: bobId });
    const gamma = (sql: string) => ({
      'app.json': JSON.stringify({ name: 'Gamma' }),
      'web/main.tsx': 'export default function App() { return null; }',
      // A name that only starts like SQLite's own tables is the app's, and goes like the others.
      'migrations/001_init.sql': `CREATE TABLE sqlitexcache (id INTEGER PRIMARY KEY); ${sql}`,
      'server/index.ts': `import { mutation, query } from '@socle/server';
        export const count = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM sqlitexcache').n);
        export const add = mutation(({ db }) => db.run('INSERT INTO sqlitexcache DEFAULT VALUES').changes);`,
    });
    assert.ok((await apps().saveDraft('gamma', gamma(''), { id: bobId })).ok);
    const again = await apps().saveDraft('gamma', gamma(''), { id: bobId }, { resetData: true });
    assert.ok(again.ok, JSON.stringify(again));
    // A reset whose migrations then fail leaves the database as it was, data included.
    const bob = new Browser(ctx.app);
    signIn(ctx, bob, BOB);
    const origin = 'https://gamma--draft.apps.test';
    await bob.navigate(`${origin}/`);
    const call = (name: string) => bob.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: {} });
    assert.equal((await call('add')).status, 200);
    const broken = await apps().saveDraft('gamma', gamma('CREATE TABLE oops ('), { id: bobId }, { resetData: true });
    assert.equal(broken.ok, false);
    assert.equal(broken.ok === false && broken.stage, 'migrate');
    assert.equal(((await (await call('count')).json()) as { value: number }).value, 1);
    // Only a draft's database: said by name.
    for (const database of ['gamma/live', 'gamma/other']) {
      assert.deepEqual(await ctx.deps.runner.migrate(database, [], { reset: true }), {
        ok: false,
        migration: null,
        message: 'only a draft database can be emptied',
      });
    }
  });

  it('accepts in a draft that was emptied nothing the published database would refuse', async () => {
    apps().create('strict', { name: 'Strict', description: '' }, { id: bobId });
    const strict = (extra: string) => ({
      'app.json': JSON.stringify({ name: 'Strict' }),
      'web/main.tsx': 'export default function App() { return null; }',
      'migrations/001_init.sql': `CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parents(id)); ${extra}`,
    });
    assert.ok((await apps().saveDraft('strict', strict(''), { id: bobId })).ok);
    // A row that points at nothing: refused when the draft's database is rebuilt, as it would be anywhere.
    const orphan = strict('INSERT INTO children (id, parent) VALUES (1, 99);');
    const emptied = await apps().saveDraft('strict', orphan, { id: bobId }, { resetData: true });
    assert.equal(emptied.ok, false);
    assert.match(JSON.stringify(emptied), /FOREIGN KEY constraint failed/);
    const direct = await ctx.deps.runner.migrate('strict/other', [
      { name: '001_init.sql', sql: orphan['migrations/001_init.sql'] },
    ]);
    assert.equal(direct.ok, false);
  });

  it('keeps each app’s log lines whatever the other apps, or its own draft, log', () => {
    apps().create('other', { name: 'Other', description: '' }, { id: bobId });
    for (let index = 0; index < 100; index++) apps().log('tasks', 'live', 'log', 'f', `line ${index}`);
    for (let index = 0; index < 400; index++) apps().log('other', 'draft', 'log', 'f', `noise ${index}`);
    for (let index = 0; index < 400; index++) apps().log('tasks', 'draft', 'log', 'f', `trial ${index}`);
    apps().log('tasks', 'live', 'log', 'f', 'one more');
    assert.equal(apps().logs('tasks', 'live', 300).length, 101);
    assert.equal(apps().logs('tasks', 'draft', 300).length, 300);
    assert.equal(apps().logs('other', 'draft', 300).length, 300);
  });

  it('does not tell an agent, nor keep, what a failure of the platform itself says', async () => {
    const { runner } = ctx.deps;
    const migrate = runner.migrate.bind(runner);
    runner.migrate = async () => ({
      ok: false,
      migration: null,
      message: 'the database could not be opened or written',
    });
    try {
      const outcome = await apps().saveDraft('tasks', tasks('four'), { id: bobId });
      assert.equal(outcome.ok, false);
      assert.doesNotMatch(JSON.stringify(outcome), /\/tmp|EACCES|ENOSPC/);
    } finally {
      runner.migrate = migrate;
    }
    assert.ok((await apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt)).ok);
  });
});

describe('a function’s input, as an app describes it', () => {
  it('records nothing but the platform’s own keywords, whatever the app puts in the object', async () => {
    const ctx = setup({ limits: TEST_LIMITS });
    try {
      const { userId } = signIn(ctx, new Browser(ctx.app), BOB);
      ctx.deps.apps.create('probe', { name: 'Probe', description: '' }, { id: userId });
      const probe = (tamper: string) => ({
        'app.json': JSON.stringify({ name: 'Probe' }),
        'web/main.tsx': 'export default function App() { return null; }',
        'server/index.ts': `import { mutation, v } from '@socle/server';
          const input = v.object({ label: v.string() });
          ${tamper}
          export const add = mutation({ tool: 'Adds a thing to the list of things.', input, handler: (_c, { label }) => label });`,
      });
      // Nothing is frozen in the sandbox: an app can add to the schema `v` built. What other software
      // would interpret (a pattern is a program) is refused by the build, not recorded.
      for (const tamper of [
        "input.schema.properties.label.pattern = '^(a+)+$';",
        "input.schema.properties.label['$ref'] = '#/x';",
        "input.schema['$id'] = 'https://example.com/schema';",
        "input.schema.properties.label.format = 'regex';",
        "input.schema.patternProperties = { '^(a+)+$': {} };",
        "input.schema.properties.label.description = 'x'.repeat(600);",
      ]) {
        const refused = await ctx.deps.apps.saveDraft('probe', probe(tamper), { id: userId });
        assert.equal(refused.ok, false, tamper);
        assert.match(JSON.stringify(refused), /unsupported keyword|only \\"date\\"|characters at most/, tamper);
      }
      const built = await ctx.deps.apps.saveDraft('probe', probe(''), { id: userId });
      assert.ok(built.ok, JSON.stringify(built));
      assert.deepEqual(ctx.deps.apps.draft('probe')!.functions.get('add')!.input, {
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
        additionalProperties: false,
      });
    } finally {
      ctx.cleanup();
    }
  });
});

describe('what ships with the platform, and what came before drafts', () => {
  it('keeps the demo app’s name for the demo app', async () => {
    const ctx = setup();
    try {
      const { userId } = signIn(ctx, new Browser(ctx.app), BOB);
      assert.equal(ctx.deps.apps.create('demo', { name: 'Mine', description: '' }, { id: userId }), 'invalid');
    } finally {
      ctx.cleanup();
    }
  });

  it('serves a published app at its draft address before anyone edits it, and sees no change in an unchanged save', async () => {
    const ctx = setup({ limits: TEST_LIMITS });
    try {
      const bob = new Browser(ctx.app);
      const { userId } = signIn(ctx, bob, BOB);
      // Published in one go, as the demo app is (and as every app was before drafts existed).
      const deployed = await ctx.deps.apps.deploy('tasks', tasks('one'), { id: userId });
      assert.ok(deployed.ok, JSON.stringify(deployed));
      const status = ctx.deps.apps.status('tasks')!;
      assert.equal(status.draft.versionId, status.live?.versionId);
      assert.equal((await bob.navigate(`${DRAFT}/`)).response.status, 200);
      assert.ok((await ctx.deps.apps.saveDraft('tasks', ctx.deps.apps.files('tasks', 'draft')!, { id: userId })).ok);
      assert.equal(ctx.deps.apps.status('tasks')!.draft.differs, false);
      assert.deepEqual(ctx.deps.apps.changes('tasks'), { added: [], changed: [], removed: [] });
    } finally {
      ctx.cleanup();
    }
  });
});

describe('text that comes from agents, on the platform’s pages', () => {
  it('is shown as text: names, descriptions and build problems', async () => {
    const ctx = setup({ limits: TEST_LIMITS });
    try {
      const admin = new Browser(ctx.app);
      const member = new Browser(ctx.app);
      const { userId } = signIn(ctx, admin, BOB);
      signIn(ctx, member, ALICE);
      const hostile = { name: '<img src=x onerror=alert(1)>', description: '"><script>alert(2)</script>' };
      assert.equal(ctx.deps.apps.create('hostile', hostile, { id: userId }), 'created');
      const files = {
        'app.json': JSON.stringify(hostile),
        'web/main.tsx': 'export default function App() { return null; }',
      };
      // A file name is not free text: one with markup in it is refused, and never kept.
      const named = await ctx.deps.apps.saveDraft('hostile', { ...files, 'web/<b>bold</b>.tsx': '' }, { id: userId });
      assert.equal(named.ok === false && named.stage, 'refused');
      assert.deepEqual(ctx.deps.apps.files('hostile', 'draft'), {});
      const built = await ctx.deps.apps.saveDraft('hostile', files, { id: userId });
      assert.ok(built.ok, JSON.stringify(built));
      const broken = { ...files, 'web/main.tsx': 'export default <script>alert(3)</script>(' };
      assert.equal((await ctx.deps.apps.saveDraft('hostile', broken, { id: userId })).ok, false);
      const page = await (await admin.request(`${CONTROL}/admin/`)).text();
      assert.match(page, /&lt;img src=x/);
      for (const markup of [/<img src=x/, /<script/i]) assert.doesNotMatch(page, markup);

      // Published, the name and description reach every member's home page.
      assert.ok((await ctx.deps.apps.saveDraft('hostile', files, { id: userId })).ok);
      assert.ok((await ctx.deps.apps.publishDraft('hostile', ctx.deps.apps.status('hostile')!.draft.versionId)).ok);
      const home = await (await member.request(`${CONTROL}/`)).text();
      assert.match(home, /&lt;img src=x/);
      for (const markup of [/<img src=x/, /<script/i]) assert.doesNotMatch(home, markup);
      const removal = await (await admin.request(`${CONTROL}/admin/apps/hostile/remove`)).text();
      for (const markup of [/<img src=x/, /<script/i]) assert.doesNotMatch(removal, markup);
    } finally {
      ctx.cleanup();
    }
  });
});
