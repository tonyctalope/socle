import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { all } from '../src/db/database.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { BOB, Browser, CONTROL, setup, signIn, type TestContext } from './helpers.ts';

// A draft is what agents edit. It is built and served apart from the published version:
// its own address, its own sessions, its own database. Members only get it once it is published.

const LIVE = 'https://tasks.apps.test';
const DRAFT = 'https://tasks--draft.apps.test';
const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 };

const tasks = (extra: Record<string, string> = {}) => ({
  'app.json': JSON.stringify({ name: 'Tasks', description: 'Who does what' }),
  'web/main.tsx': `
    import { Page } from '@socle/ui';
    export default function App() { return <Page title="Tasks">v1</Page>; }`,
  'migrations/001_init.sql': 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
  'server/index.ts': `
    import { mutation, query, v } from '@socle/server';
    export const list = query(({ db }) => db.all('SELECT id, label FROM tasks ORDER BY id'));
    export const add = mutation({
      input: v.object({ label: v.string().min(1) }),
      handler: ({ db }, { label }) => db.run('INSERT INTO tasks (label) VALUES (?)', label).lastInsertRowid,
    });
    export const noisy = query(() => { console.log('checked the list'); return 1; });
    export const broken = query(() => missingVariable);
  `,
  ...extra,
});

describe('a draft, from the first file to its publication', () => {
  let ctx: TestContext;
  let bob: Browser;
  let bobId: number;

  before(() => {
    ctx = setup({ limits: TEST_LIMITS });
    bob = new Browser(ctx.app);
    bobId = signIn(ctx, bob, BOB).userId;
  });
  after(() => ctx.cleanup());

  const call = (origin: string, name: string, input: unknown = {}) =>
    bob.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: { input } });
  const value = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as { value: unknown }).value;
  };
  const { apps } = setupLater(() => ctx);

  it('creates an app that nobody sees until it is published', async () => {
    assert.equal(apps().create('Tasks!', { name: 'Tasks', description: '' }, { id: bobId }), 'invalid');
    assert.equal(apps().create('tasks', { name: 'Tasks', description: 'Who does what' }, { id: bobId }), 'created');
    assert.equal(apps().create('tasks', { name: 'Tasks', description: '' }, { id: bobId }), 'exists');
    assert.deepEqual(apps().files('tasks', 'draft'), {});
    assert.equal(apps().files('tasks', 'live'), null);
    assert.doesNotMatch(await (await bob.request(`${CONTROL}/`)).text(), /tasks\.apps\.test/);

    const built = await apps().saveDraft('tasks', tasks(), { id: bobId });
    assert.ok(built.ok, JSON.stringify(built));
    assert.deepEqual(built.applied, ['001_init.sql']);

    // The draft address serves it, to signed-in members only; the published address has nothing yet.
    const anonymous = await new Browser(ctx.app).navigate(`${DRAFT}/`);
    assert.equal(new URL(anonymous.url).origin, CONTROL);
    const page = await bob.navigate(`${DRAFT}/`);
    assert.equal(page.url, `${DRAFT}/`);
    const html = await page.response.text();
    assert.match(html, /<title>Tasks \(draft\)<\/title>/);
    const manifest = (await (await bob.request(`${DRAFT}/_socle/manifest.webmanifest`)).json()) as { name: string };
    assert.equal(manifest.name, 'Tasks (draft)');
    const live = await bob.navigate(`${LIVE}/`);
    assert.equal(live.response.status, 404);
    assert.match(await live.response.text(), /no published version yet/);
    assert.equal((await call(LIVE, 'list')).status, 404);

    assert.equal(await value(await call(DRAFT, 'add', { label: 'try the draft' })), 1);
    assert.deepEqual(await value(await call(DRAFT, 'list')), [{ id: 1, label: 'try the draft' }]);
    assert.deepEqual(apps().status('tasks'), {
      slug: 'tasks',
      name: 'Tasks',
      description: 'Who does what',
      live: null,
      draft: {
        versionId: built.versionId,
        updatedAt: apps().status('tasks')!.draft.updatedAt,
        problems: null,
        differs: true,
      },
    });
  });

  it('keeps the two addresses apart: sessions, data, notifications', async () => {
    // The session of the draft address is not one of the published address, and the other way round.
    const cookie = bob.cookie(DRAFT, '__Host-socle_app')!;
    const thief = new Browser(ctx.app);
    thief.setCookie(LIVE, '__Host-socle_app', cookie);
    assert.equal((await thief.fetch(`${LIVE}/_socle/api/me`)).status, 401);
    const scopes = all<{ scope: string }>(ctx.deps.db, 'SELECT DISTINCT scope FROM sessions ORDER BY scope');
    assert.ok(scopes.some((row) => row.scope === 'tasks--draft'));
    // A request for the draft's functions from a page of the published app is another origin.
    const cross = await bob.fetch(`${DRAFT}/_socle/api/fn/list`, {
      method: 'POST',
      json: { input: {} },
      headers: { origin: LIVE },
    });
    assert.equal(cross.status, 403);
  });

  it('publishes the draft: members get it, on a database that starts empty', async () => {
    const published = await apps().publishDraft('tasks');
    assert.ok(published.ok, JSON.stringify(published));
    assert.equal(published.unchanged, false);
    assert.deepEqual(published.applied, ['001_init.sql']);
    assert.match(await (await bob.request(`${CONTROL}/`)).text(), /href="https:\/\/tasks\.apps\.test\/"/);
    const page = await bob.navigate(`${LIVE}/`);
    assert.match(await page.response.text(), /<title>Tasks<\/title>/);
    // What was tried in the draft stayed in the draft.
    assert.deepEqual(await value(await call(LIVE, 'list')), []);
    assert.equal(await value(await call(LIVE, 'add', { label: 'real work' })), 1);
    assert.deepEqual(await value(await call(DRAFT, 'list')), [{ id: 1, label: 'try the draft' }]);
    const status = apps().status('tasks')!;
    assert.equal(status.live?.versionId, status.draft.versionId);
    assert.equal(status.draft.differs, false);
    assert.deepEqual(apps().files('tasks', 'draft'), tasks());
    // Publishing again changes nothing.
    assert.deepEqual(await apps().publishDraft('tasks'), {
      ok: true,
      versionId: status.live!.versionId,
      unchanged: true,
      applied: [],
    });
  });

  it('changes nothing for members while the draft is edited, built or broken', async () => {
    const next = tasks({
      'web/main.tsx': `
        import { Page } from '@socle/ui';
        export default function App() { return <Page title="Tasks">v2</Page>; }`,
      'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
    });
    const built = await apps().saveDraft('tasks', next, { id: bobId });
    assert.ok(built.ok, JSON.stringify(built));
    assert.deepEqual(built.applied, ['002_done.sql']);
    const before = apps().status('tasks')!;
    assert.equal(before.draft.differs, true);
    assert.notEqual(before.draft.versionId, before.live?.versionId);
    assert.deepEqual(apps().files('tasks', 'live'), tasks());
    assert.deepEqual(apps().files('tasks', 'draft'), next);

    // A draft that does not build: its files are kept, the draft address keeps the last one that did.
    const broken = await apps().saveDraft('tasks', { ...next, 'web/main.tsx': 'export default function (' }, null);
    assert.equal(broken.ok, false);
    assert.equal(apps().status('tasks')!.draft.versionId, before.draft.versionId);
    assert.ok(apps().status('tasks')!.draft.problems!.length > 0);
    assert.equal(apps().files('tasks', 'draft')!['web/main.tsx'], 'export default function (');
    assert.deepEqual(await apps().publishDraft('tasks'), {
      ok: false,
      stage: 'build',
      problems: [{ message: 'the draft does not build' }],
    });
    assert.deepEqual(await value(await call(LIVE, 'list')), [{ id: 1, label: 'real work' }]);

    // Fixed and published: the published data gets the new column and keeps its rows.
    assert.ok((await apps().saveDraft('tasks', next, { id: bobId })).ok);
    const published = await apps().publishDraft('tasks');
    assert.ok(published.ok, JSON.stringify(published));
    assert.deepEqual(published.applied, ['002_done.sql']);
    assert.deepEqual(await value(await call(LIVE, 'list')), [{ id: 1, label: 'real work' }]);
  });

  it('starts the draft’s data again when a migration was rewritten, never the published data', async () => {
    const rewritten = tasks({
      'migrations/001_init.sql': 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL, owner INTEGER);',
    });
    const refused = await apps().saveDraft('tasks', rewritten, { id: bobId });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.stage, 'migrate');
    const again = await apps().saveDraft('tasks', rewritten, { id: bobId }, { resetData: true });
    assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual(again.applied, ['001_init.sql']);
    assert.deepEqual(await value(await call(DRAFT, 'list')), []);
    // Publishing it is refused by the published database, which already ran the first migration as it was.
    const published = await apps().publishDraft('tasks');
    assert.equal(published.ok, false);
    assert.equal(published.ok === false && published.stage, 'migrate');
    assert.deepEqual(await value(await call(LIVE, 'list')), [{ id: 1, label: 'real work' }]);
    assert.deepEqual(await ctx.deps.runner.migrate('tasks/live', [], { reset: true }), {
      ok: false,
      migration: null,
      message: 'the published database is never emptied',
    });
    // Back to a draft that fits the published data.
    const fits = tasks({ 'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' });
    assert.ok((await apps().saveDraft('tasks', fits, { id: bobId }, { resetData: true })).ok);
  });

  it('keeps what functions print and how they fail, for whoever writes the app', async () => {
    assert.equal(await value(await call(DRAFT, 'noisy')), 1);
    assert.equal((await call(DRAFT, 'broken')).status, 500);
    assert.equal((await call(DRAFT, 'add', { label: '' })).status, 400); // refused input is not a fault
    const lines = apps().logs('tasks', 'draft');
    assert.deepEqual(
      lines.map((line) => [line.level, line.fn, line.message.split(':')[0]]),
      [
        ['error', 'broken', 'error'],
        ['log', 'noisy', 'checked the list'],
      ],
    );
    assert.deepEqual(apps().logs('tasks', 'live'), []);
    for (let i = 0; i < 320; i++) apps().log('tasks', 'draft', 'log', 'noisy', `line ${i}`);
    assert.equal(apps().logs('tasks', 'draft', 1000).length, 300);
  });

  it('does not pile up versions: drafts that were built again are forgotten, publications are kept', async () => {
    for (let i = 0; i < 4; i++) {
      const files = tasks({
        'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
        'web/main.tsx': `
          import { Page } from '@socle/ui';
          export default function App() { return <Page title="Tasks">draft ${i}</Page>; }`,
      });
      assert.ok((await apps().saveDraft('tasks', files, { id: bobId })).ok);
    }
    const versions = all<{ id: number; published_at: string | null }>(
      ctx.deps.db,
      "SELECT id, published_at FROM app_versions WHERE app = 'tasks' ORDER BY id",
    );
    // Two publications, and the one draft the draft address serves.
    assert.equal(versions.filter((version) => version.published_at !== null).length, 2);
    assert.equal(versions.filter((version) => version.published_at === null).length, 1);
    assert.equal(versions.at(-1)!.id, apps().status('tasks')!.draft.versionId);
  });
});

/** The store of a context that only exists once `before` ran. */
function setupLater(context: () => TestContext) {
  return { apps: () => context().deps.apps };
}
