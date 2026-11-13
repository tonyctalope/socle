import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runSchedules, slotOf } from '../src/apps/scheduler.ts';
import { DEFAULT_LIMITS } from '../src/runner/limits.ts';
import { ALICE, BOB, Browser, setup, signIn, type TestContext } from './helpers.ts';

// Functions an app asks the platform to run by itself.

const LIVE = 'https://chores.apps.test';
const DRAFT = 'https://chores--draft.apps.test';
const TEST_LIMITS = { ...DEFAULT_LIMITS, callMs: 1_500, killGraceMs: 300 };

const chores = (server: string) => ({
  'app.json': JSON.stringify({ name: 'Chores' }),
  'web/main.tsx': 'export default function App() { return null; }',
  'migrations/001_init.sql':
    'CREATE TABLE runs (id INTEGER PRIMARY KEY, day TEXT NOT NULL, who TEXT, members INTEGER);',
  'server/index.ts': server,
});

const SERVER = `
  import { query, schedule } from '@socle/server';
  export const runs = query(({ db }) => db.all('SELECT day, who, members FROM runs ORDER BY id'));
  export const remind = schedule({
    every: 'day',
    at: '08:00',
    handler: ({ db, user, members, today, notify }) => {
      db.run('INSERT INTO runs (day, who, members) VALUES (?, ?, ?)', today, user === null ? 'nobody' : user.name, members.length);
      notify('others', { title: 'Chores of ' + today });
    },
  });`;

describe('when a schedule is due', () => {
  const paris = (iso: string) => new Date(iso);

  it('names the latest occurrence that has come, in the members’ timezone', () => {
    const daily = { every: 'day', at: '08:00' } as const;
    // 08:00 in Paris is 07:00 UTC in winter.
    assert.equal(slotOf(daily, 'Europe/Paris', paris('2027-01-15T06:59:00Z')), '2027-01-14');
    assert.equal(slotOf(daily, 'Europe/Paris', paris('2027-01-15T07:00:00Z')), '2027-01-15');
    assert.equal(slotOf(daily, 'Europe/Paris', paris('2027-01-15T23:30:00Z')), '2027-01-15'); // 00:30 on the 16th: the 15th's until 08:00
    assert.equal(slotOf(daily, 'UTC', paris('2027-01-15T07:00:00Z')), '2027-01-14');
    assert.equal(slotOf({ every: 'hour' }, 'Europe/Paris', paris('2027-01-15T07:59:00Z')), '2027-01-15T08');
    // 2027-01-15 is a Friday.
    const weekly = { every: 'week', on: 'monday', at: '07:30' } as const;
    assert.equal(slotOf(weekly, 'Europe/Paris', paris('2027-01-15T12:00:00Z')), '2027-01-11');
    assert.equal(slotOf(weekly, 'Europe/Paris', paris('2027-01-18T06:29:00Z')), '2027-01-11'); // Monday, 07:29
    assert.equal(slotOf(weekly, 'Europe/Paris', paris('2027-01-18T06:30:00Z')), '2027-01-18'); // Monday, 07:30
    // Later occurrences always sort after earlier ones.
    assert.ok(
      slotOf(daily, 'Europe/Paris', paris('2027-02-01T08:00:00Z')) >
        slotOf(daily, 'Europe/Paris', paris('2027-01-31T08:00:00Z')),
    );
  });
});

describe('scheduled functions', () => {
  let ctx: TestContext;
  let bob: Browser;
  let bobId: number;
  const apps = () => ctx.deps.apps;
  const at = (iso: string) => {
    ctx.clock.now = new Date(iso);
  };
  const call = (origin: string, name: string) =>
    bob.fetch(`${origin}/_socle/api/fn/${name}`, { method: 'POST', json: { input: null } });
  const runsOf = async (origin: string) => ((await (await call(origin, 'runs')).json()) as { value: unknown }).value;

  before(async () => {
    ctx = setup({ limits: TEST_LIMITS, env: { APP_TIMEZONE: 'Europe/Paris' } });
    bob = new Browser(ctx.app);
    bobId = signIn(ctx, bob, BOB).userId;
    signIn(ctx, new Browser(ctx.app), ALICE);
    apps().create('chores', { name: 'Chores', description: '' }, { id: bobId });
  });
  after(() => ctx.cleanup());

  it('refuses a schedule that is not one of the three shapes, or that is also something else', async () => {
    const bad = (definition: string) =>
      chores(`import { schedule, v } from '@socle/server';\nexport const job = schedule(${definition});`);
    for (const definition of [
      "{ every: 'minute', handler: () => 1 }",
      "{ every: 'day', handler: () => 1 }",
      "{ every: 'day', at: '25:00', handler: () => 1 }",
      "{ every: 'week', at: '08:00', handler: () => 1 }",
      "{ every: 'week', on: 'someday', at: '08:00', handler: () => 1 }",
      "{ every: 'hour', at: '08:00', handler: () => 1 }",
      "{ every: 'day', at: '08:00', input: v.object({}), handler: () => 1 }",
      "{ every: 'day', at: '08:00', tool: 'Runs the daily job of the app', handler: () => 1 }",
    ]) {
      const outcome = await apps().saveDraft('chores', bad(definition), { id: bobId });
      assert.equal(outcome.ok, false, definition);
      assert.match(JSON.stringify(outcome), /schedule/);
    }
    const eleven = Array.from(
      { length: 11 },
      (_, index) => `export const job${index} = schedule({ every: 'hour', handler: () => 1 });`,
    );
    const many = await apps().saveDraft(
      'chores',
      chores(`import { schedule } from '@socle/server';\n${eleven.join('\n')}`),
      { id: bobId },
    );
    assert.match(JSON.stringify(many), /too many scheduled functions/);
  });

  it('runs only what is published, once per occurrence, without a caller', async () => {
    at('2027-01-15T10:00:00Z');
    assert.ok((await apps().saveDraft('chores', chores(SERVER), { id: bobId })).ok);
    // A draft's schedule does not run.
    assert.equal(await runSchedules(ctx.deps), 0);
    assert.ok((await apps().publishDraft('chores', apps().status('chores')!.draft.versionId)).ok);
    await bob.navigate(`${LIVE}/`);
    await bob.navigate(`${DRAFT}/`);

    // Published after today's 08:00: it starts with tomorrow's occurrence, not with one that passed.
    assert.equal(await runSchedules(ctx.deps), 0);
    assert.deepEqual(await runsOf(LIVE), []);
    at('2027-01-16T06:59:00Z');
    assert.equal(await runSchedules(ctx.deps), 0);
    at('2027-01-16T07:00:00Z'); // 08:00 in Paris
    ctx.push.sent.length = 0;
    assert.equal(await runSchedules(ctx.deps), 1);
    assert.deepEqual(await runsOf(LIVE), [{ day: '2027-01-16', who: 'nobody', members: 2 }]);
    // Without a caller, "others" is every member.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(new Set(ctx.push.sent.map((sent) => sent.userId)).size, 2);
    assert.ok(ctx.push.sent.every((sent) => sent.app === 'chores' && sent.message.title === 'Chores of 2027-01-16'));
    // The same occurrence is not run again, however often the platform looks.
    at('2027-01-16T07:01:00Z');
    assert.equal(await runSchedules(ctx.deps), 0);
    at('2027-01-16T22:00:00Z');
    assert.equal(await runSchedules(ctx.deps), 0);
    // The draft's data saw none of it.
    assert.deepEqual(await runsOf(DRAFT), []);
  });

  it('runs once what was missed while the platform was away, not every occurrence it missed', async () => {
    at('2027-01-20T12:00:00Z'); // four occurrences later
    assert.equal(await runSchedules(ctx.deps), 1);
    assert.deepEqual(await runsOf(LIVE), [
      { day: '2027-01-16', who: 'nobody', members: 2 },
      { day: '2027-01-20', who: 'nobody', members: 2 },
    ]);
    assert.equal(await runSchedules(ctx.deps), 0);
  });

  it('tries again when the platform could not make the call, and not when the function itself failed', async () => {
    const { runner } = ctx.deps;
    const realCall = runner.call.bind(runner);
    at('2027-01-21T07:00:00Z');
    runner.call = async () => {
      throw new (await import('../src/runner/client.ts')).RunnerUnavailable('closed', 'the runner is away');
    };
    try {
      assert.equal(await runSchedules(ctx.deps), 0);
    } finally {
      runner.call = realCall;
    }
    assert.equal(await runSchedules(ctx.deps), 1); // the same occurrence, a minute later
    // A function that throws had its run: it is in the app's log, and it waits for the next occurrence.
    const failing = SERVER.replace("notify('others'", "throw new Error('no luck'); notify('others'");
    assert.ok((await apps().saveDraft('chores', chores(failing), { id: bobId })).ok);
    assert.ok((await apps().publishDraft('chores', apps().status('chores')!.draft.versionId)).ok);
    at('2027-01-22T07:00:00Z');
    assert.equal(await runSchedules(ctx.deps), 1);
    assert.equal(await runSchedules(ctx.deps), 0);
    assert.match(apps().logs('chores', 'live')[0]!.message, /no luck/);
    assert.equal(((await runsOf(LIVE)) as unknown[]).length, 3); // its insert was undone with it
  });

  it('is nobody’s to call: not from a screen, and not offered as a tool', async () => {
    const response = await call(LIVE, 'remind');
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, 'unknown_function');
    assert.equal((await call(DRAFT, 'remind')).status, 404);
    assert.equal(apps().live('chores')!.functions.get('remind')!.tool, null);
  });
});
