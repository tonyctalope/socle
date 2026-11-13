import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, Browser, CONTROL, setup, signIn, type TestContext } from './helpers.ts';

// What an administrator decides about one app besides publishing it: which earlier version
// members get back, and who can open the app at all.

const LIVE = 'https://tasks.apps.test';
const DRAFT = 'https://tasks--draft.apps.test';
const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 };

const tasks = (mark: string, extra: Record<string, string> = {}) => ({
  'app.json': JSON.stringify({ name: `Tasks ${mark}` }),
  'web/main.tsx': `export default function App() { return <p>${mark}</p>; }`,
  'migrations/001_init.sql': 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
  'server/index.ts': `
    import { mutation, query } from '@socle/server';
    export const list = query(({ db }) => db.all('SELECT label FROM tasks ORDER BY id'));
    export const who = query(({ members }) => members.map((member) => member.name));
    export const add = mutation(({ db }) => db.run("INSERT INTO tasks (label) VALUES ('${mark}')").changes);
  `,
  ...extra,
});

describe('one app, in the administration', () => {
  let ctx: TestContext;
  let admin: Browser;
  let member: Browser;
  let adminId: number;
  const apps = () => ctx.deps.apps;

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS });
    admin = new Browser(ctx.app);
    member = new Browser(ctx.app);
    adminId = signIn(ctx, admin, BOB).userId;
    signIn(ctx, member, ALICE);
    apps().create('tasks', { name: 'Tasks', description: '' }, { id: adminId });
  });
  after(() => ctx.cleanup());

  const publish = async (files: Record<string, string>) => {
    assert.ok((await apps().saveDraft('tasks', files, { id: adminId })).ok);
    const published = await apps().publishDraft('tasks', apps().status('tasks')!.draft.versionId);
    assert.ok(published.ok, JSON.stringify(published));
    return published.versionId;
  };
  const form = (browser: Browser, action: string, body: string, origin = CONTROL) =>
    browser.request(`${CONTROL}/admin/apps/tasks/${action}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  const call = (browser: Browser, origin: string, name: string) =>
    browser.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: { input: null } });
  const value = async (response: Response) => ((await response.json()) as { value: unknown }).value;
  const title = async (browser: Browser, origin: string) =>
    /<title>([^<]*)<\/title>/.exec(await (await browser.navigate(`${origin}/`)).response.text())?.[1];

  it('brings back an earlier version: its screens and functions, on the data as it is', async () => {
    const first = await publish(tasks('one'));
    await admin.navigate(`${LIVE}/`);
    assert.equal(await value(await call(admin, LIVE, 'add')), 1);
    const second = await publish(tasks('two'));
    assert.equal(await title(admin, LIVE), 'Tasks two');

    const page = await (await admin.request(`${CONTROL}/admin/apps/tasks/`)).text();
    assert.match(page, /published now/);
    assert.match(page, new RegExp(`name="version" value="${first}"`));
    assert.doesNotMatch(page, new RegExp(`name="version" value="${second}"`)); // nothing to come back to: it is live

    // Not a member, not a page of the app, not a version that does not exist.
    assert.equal((await form(member, 'return', `version=${first}`)).status, 403);
    assert.equal((await form(admin, 'return', `version=${first}`, LIVE)).status, 403);
    assert.equal((await form(admin, 'return', 'version=9999')).status, 409);
    assert.equal((await form(admin, 'return', 'version=abc')).status, 400);
    assert.equal(apps().status('tasks')!.live?.versionId, second);

    const back = await form(admin, 'return', `version=${first}`);
    assert.equal(back.status, 303);
    assert.equal(apps().status('tasks')!.live?.versionId, first);
    assert.equal(await title(admin, LIVE), 'Tasks one');
    assert.equal(await value(await call(admin, LIVE, 'add')), 1);
    assert.deepEqual(await value(await call(admin, LIVE, 'list')), [{ label: 'one' }, { label: 'one' }]);
    // Nobody was editing: the draft address follows, and there is nothing waiting to be published.
    assert.equal(apps().status('tasks')!.draft.versionId, first);
    assert.equal(apps().status('tasks')!.draft.differs, false);
    assert.equal(await title(admin, DRAFT), 'Tasks one (draft)');
    // And forward again.
    assert.equal((await form(admin, 'return', `version=${second}`)).status, 303);
    assert.equal(await title(admin, LIVE), 'Tasks two');
  });

  it('does not bring back a version from before the data changed shape', async () => {
    const before = apps().status('tasks')!.live!.versionId;
    const third = await publish(
      tasks('three', { 'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' }),
    );
    const listed = apps().versions('tasks');
    assert.deepEqual(
      listed.map((version) => [version.id === third, version.live, version.canReturn]),
      [
        [true, true, false],
        [false, false, false],
        [false, false, false],
      ],
    );
    const page = await (await admin.request(`${CONTROL}/admin/apps/tasks/`)).text();
    assert.match(page, /the data changed shape since/);
    assert.doesNotMatch(page, /name="version"/);
    const refused = await form(admin, 'return', `version=${before}`);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /the data changed shape since this version/);
    assert.equal(apps().status('tasks')!.live?.versionId, third);
    // A draft in progress is left alone by a return.
    const fourth = await publish(
      tasks('four', { 'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' }),
    );
    assert.ok(
      (
        await apps().saveDraft(
          'tasks',
          tasks('five', { 'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' }),
          { id: adminId },
        )
      ).ok,
    );
    const editing = apps().status('tasks')!.draft.versionId;
    assert.equal((await form(admin, 'return', `version=${third}`)).status, 303);
    assert.equal(apps().status('tasks')!.live?.versionId, third);
    assert.equal(apps().status('tasks')!.draft.versionId, editing);
    assert.equal(apps().status('tasks')!.draft.differs, true);
    assert.notEqual(fourth, third);
    assert.ok((await apps().discardDraft('tasks', apps().status('tasks')!.draft.updatedAt)).ok);
  });

  it('limits an app to the members an administrator lists', async () => {
    await member.navigate(`${LIVE}/`);
    await member.navigate(`${DRAFT}/`);
    assert.equal((await call(member, LIVE, 'list')).status, 200);
    assert.deepEqual(await value(await call(admin, LIVE, 'who')), ['bob', 'alice']);
    assert.match(await (await member.request(`${CONTROL}/`)).text(), /tasks\.apps\.test/);

    assert.equal((await form(member, 'access', `who=some&email=${encodeURIComponent(ALICE)}`)).status, 403);
    // An address that is not on the allowlist cannot be listed.
    const saved = await form(admin, 'access', `who=some&email=${encodeURIComponent(BOB)}&email=mallory%40example.net`);
    assert.equal(saved.status, 303);
    assert.equal(
      ctx.deps.db.prepare("SELECT access FROM apps WHERE slug = 'tasks'").get()!.access,
      JSON.stringify([BOB]),
    );
    const page = await (await admin.request(`${CONTROL}/admin/apps/tasks/`)).text();
    assert.match(page, new RegExp(`value="${BOB}" checked`));
    assert.doesNotMatch(page, new RegExp(`value="${ALICE}" checked`));

    // The member who is not listed: no session on either address any more, no way back in, not on
    // the home page, and not among the members the app is told about.
    assert.equal((await call(member, LIVE, 'list')).status, 401);
    assert.equal((await call(member, DRAFT, 'list')).status, 401);
    const again = await member.navigate(`${LIVE}/`);
    assert.equal(new URL(again.url).origin, CONTROL);
    assert.equal(again.response.status, 403);
    assert.doesNotMatch(await (await member.request(`${CONTROL}/`)).text(), /tasks\.apps\.test/);
    assert.equal((await call(admin, LIVE, 'list')).status, 200);
    assert.deepEqual(await value(await call(admin, LIVE, 'who')), ['bob']);

    // Open to every member again.
    assert.equal((await form(admin, 'access', 'who=everyone')).status, 303);
    assert.equal((await member.navigate(`${LIVE}/`)).response.status, 200);
    assert.deepEqual(await value(await call(member, LIVE, 'who')), ['bob', 'alice']);
    // "Only these members" with nobody ticked is nobody, not everybody.
    assert.equal((await form(admin, 'access', 'who=some')).status, 303);
    assert.equal((await call(admin, LIVE, 'list')).status, 401);
    assert.equal((await form(admin, 'access', 'who=everyone')).status, 303);
  });

  it('gives an app its own icon, drawn once by its author and rendered for every phone', async () => {
    const anonymous = new Browser(ctx.app);
    const icon = async (origin: string, file: string) => {
      const response = await anonymous.request(`${origin}/_socle/icons/${file}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A PNG says its width in bytes 16 to 19.
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        bytes,
        width: new DataView(bytes.buffer).getUint32(16),
      };
    };
    const platform = await icon(LIVE, 'icon-192.png');
    assert.equal(platform.status, 200);

    const picture =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#4f46e5"/><circle cx="50" cy="50" r="24" fill="#fff"/></svg>';
    const withIcon = (svg: string) =>
      tasks('icon', {
        'icon.svg': svg,
        'migrations/002_done.sql': 'ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;',
      });
    // A picture that cannot be drawn, or is not square, is a build problem like another.
    for (const [svg, reason] of [
      ['<svg xmlns="http://www.w3.org/2000/svg"', /icon is not an SVG picture/],
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>',
        /must be square/,
      ],
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--${'x'.repeat(70_000)}--></svg>`, /too large/],
    ] as const) {
      const refused = await apps().saveDraft('tasks', withIcon(svg), { id: adminId });
      assert.equal(refused.ok, false);
      assert.match(JSON.stringify(refused), reason);
      assert.match(JSON.stringify(refused), /"file":"icon\.svg"/);
    }

    assert.ok((await apps().saveDraft('tasks', withIcon(picture), { id: adminId })).ok);
    // The draft has it at once; members keep the published one until publication.
    const draftIcon = await icon(DRAFT, 'icon-192.png');
    assert.equal(draftIcon.type, 'image/png');
    assert.equal(draftIcon.width, 192);
    assert.notDeepEqual(draftIcon.bytes, platform.bytes);
    assert.deepEqual((await icon(LIVE, 'icon-192.png')).bytes, platform.bytes);
    assert.ok((await apps().publishDraft('tasks', apps().status('tasks')!.draft.versionId)).ok);

    const sizes = {
      'icon-192.png': 192,
      'icon-512.png': 512,
      'icon-maskable-192.png': 192,
      'icon-maskable-512.png': 512,
      'apple-touch-icon.png': 180,
    };
    for (const [file, width] of Object.entries(sizes)) {
      const served = await icon(LIVE, file);
      assert.equal(served.status, 200, file);
      assert.equal(served.width, width, file);
    }
    assert.notDeepEqual((await icon(LIVE, 'icon-maskable-192.png')).bytes, (await icon(LIVE, 'icon-192.png')).bytes);
    // What only the platform has (the notification badge) is still the platform's.
    assert.equal((await icon(LIVE, 'badge-96.png')).status, 200);

    // The addresses of the icons change with the icon, so that phones fetch the new one.
    const version = apps().status('tasks')!.live!.versionId;
    const manifest = (await (await anonymous.request(`${LIVE}/_socle/manifest.webmanifest`)).json()) as {
      icons: { src: string }[];
    };
    assert.ok(manifest.icons.every((entry) => entry.src.endsWith(`?v=${version}`)));
    const page = await (await admin.navigate(`${LIVE}/`)).response.text();
    assert.match(page, new RegExp(`apple-touch-icon\\.png\\?v=${version}"`));
    // On the home page too.
    const home = await (await admin.request(`${CONTROL}/`)).text();
    assert.match(home, new RegExp(`<img src="/icons/app/tasks\\?v=${version}"`));
    const listed = await admin.request(`${CONTROL}/icons/app/tasks`);
    assert.deepEqual(new Uint8Array(await listed.arrayBuffer()), (await icon(LIVE, 'icon-192.png')).bytes);
    // An app without its own icon, or that does not exist, shows the platform's.
    assert.deepEqual(
      new Uint8Array(await (await admin.request(`${CONTROL}/icons/app/demo`)).arrayBuffer()),
      platform.bytes,
    );
    assert.equal((await admin.request(`${CONTROL}/icons/app/nope`)).status, 200);
  });

  it('refuses files that lost a migration the data already ran', async () => {
    apps().create('ledger', { name: 'Ledger', description: '' }, { id: adminId });
    const save = (files: Record<string, string>, options?: { resetData?: boolean }) =>
      apps().saveDraft('ledger', files, { id: adminId }, options);
    const publishNow = () => apps().publishDraft('ledger', apps().status('ledger')!.draft.versionId);
    const renamed: Record<string, string> = tasks('two', {
      'migrations/002_rename.sql': 'ALTER TABLE tasks RENAME TO chores;',
    });
    const { 'migrations/002_rename.sql': _gone, ...without } = renamed;

    assert.ok((await save(tasks('one'))).ok);
    const first = await publishNow();
    assert.ok(first.ok);

    // The draft's data ran 002: files without it no longer describe that data, and are refused
    // rather than built on a schema nothing else will ever have.
    assert.ok((await save(renamed)).ok);
    const dropped = await save(without);
    assert.ok(!dropped.ok && dropped.stage === 'migrate', JSON.stringify(dropped));
    assert.equal(dropped.problems[0]!.file, 'migrations/002_rename.sql');
    assert.match(dropped.problems[0]!.message, /its file is gone/);
    // Starting the draft's data again makes the two agree.
    assert.ok((await save(without, { resetData: true })).ok);

    // Once published, a migration is there for good: no later version leaves it out.
    assert.ok((await save(renamed)).ok);
    const second = await publishNow();
    assert.ok(second.ok, JSON.stringify(second));
    assert.ok((await save(without, { resetData: true })).ok);
    const refused = await publishNow();
    assert.ok(!refused.ok && refused.stage === 'migrate', JSON.stringify(refused));
    assert.match(refused.problems[0]!.message, /its file is gone/);
    assert.equal(apps().status('ledger')!.live?.versionId, second.versionId);
    // So two versions with the same list of migrations do expect the same data, and the
    // version from before the rename cannot come back onto renamed tables.
    const versions = apps().versions('ledger');
    assert.deepEqual(
      versions.map((version) => [version.id, version.canReturn]),
      [
        [second.versionId, false],
        [first.versionId, false],
      ],
    );
  });
});
