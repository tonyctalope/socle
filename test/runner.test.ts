import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { localRunner, remoteRunner, RunnerUnavailable, type Runner } from '../src/runner/client.ts';
import { DEFAULT_LIMITS, type Limits } from '../src/runner/limits.ts';
import { WorkerPool, PoolFailure } from '../src/runner/pool.ts';
import type { CallResult } from '../src/runner/sandbox/call.ts';
import { startRunner } from '../src/runner/supervisor.ts';

// The runner as the web process sees it: jobs go to worker processes, and a job that
// does not come back in time gets its worker killed. This is what makes the time
// limit a guarantee, including for what the interpreter cannot interrupt (SQL).

const LIMITS: Limits = { ...DEFAULT_LIMITS, callMs: 300, killGraceMs: 300, guestMemory: 16 * 1024 * 1024 };
const dir = mkdtempSync(path.join(tmpdir(), 'socle-runner-'));
const TONY = { id: 1, name: 'Tony' };

const SOURCE = {
  'app.json': '{ "name": "Notes" }',
  'web/main.tsx': 'export default function App() { return <p className="p-4">Notes</p>; }',
  'migrations/001_init.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);',
  'server/index.ts': `
    import { mutation, query, v } from '@socle/server';
    export const count = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM notes').n);
    export const add = mutation({
      input: v.object({ body: v.string().min(1) }),
      handler: ({ db }, { body }) => db.run('INSERT INTO notes (body) VALUES (?)', body).lastInsertRowid,
    });
    const FOREVER = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) AS n FROM c';
    // A few hundred megabytes held by SQLite itself, outside the sandbox's own memory.
    const HEAVY = \`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400),
      m AS MATERIALIZED (SELECT randomblob(1000000) AS b FROM c) SELECT COUNT(*) AS n, SUM(LENGTH(b)) AS bytes FROM m\`;
    export const heavySql = query(({ db }) => db.get(HEAVY));
    export const endlessSql = query(({ db }) => db.get(FOREVER));
    export const endlessWrite = mutation(({ db }) => {
      db.run("INSERT INTO notes (body) VALUES ('ghost')");
      return db.get(FOREVER);
    });
    export const stubbornMemory = mutation(() => { const all = []; for (;;) { try { all.push('x'.repeat(1 << 20)); } catch {} } });
    export const slowSteps = query(() => { const big = 'ab'.repeat(200000); for (;;) big.split('a').join('b'); });
    export const spin = query(() => { for (;;) {} });
  `,
};

function valueOf(result: CallResult): unknown {
  assert.ok(result.ok, JSON.stringify(result));
  return JSON.parse(result.json);
}

async function deploy(runner: Runner, app: string) {
  const built = await runner.build(SOURCE);
  assert.ok(built.ok, JSON.stringify(built));
  const database = `${app}/live`;
  const migrated = await runner.migrate(database, built.app.migrations);
  assert.deepEqual(migrated, { ok: true, applied: ['001_init.sql'], unknown: [] });
  const bundleHash = await runner.install(app, built.app.server!.bundle);
  const call = (fn: string, input: unknown = null) =>
    runner.call({
      database,
      bundleHash,
      fn,
      inputJson: JSON.stringify(input),
      user: TONY,
      members: [TONY],
      now: Date.now(),
      today: '2027-01-15',
    });
  return { call, built: built.app };
}

describe('the runner, as the web process uses it', () => {
  const runner = localRunner({ appsDir: path.join(dir, 'local'), limits: LIMITS, workers: 2 });
  after(() => runner.close());

  it('builds, migrates and calls', async () => {
    const notes = await deploy(runner, 'basic');
    assert.deepEqual(notes.built.manifest, { name: 'Notes', description: '', themeColor: null, backgroundColor: null });
    assert.match(notes.built.web.js, /\/_socle\/vendor\/sdk\.js/);
    assert.deepEqual(await notes.call('add', { body: 'Pain' }), {
      ok: true,
      kind: 'mutation',
      json: '1',
      effects: [],
      logs: [],
    });
    assert.deepEqual(await notes.call('count'), { ok: true, kind: 'query', json: '1', effects: [], logs: [] });
    const refused = await notes.call('add', {});
    assert.ok(!refused.ok && refused.error.code === 'invalid_input');
  });

  it('reports build errors as data', async () => {
    const outcome = await runner.build({
      ...SOURCE,
      'web/main.tsx': 'import _ from "lodash"; export default () => _;',
    });
    assert.ok(!outcome.ok);
    assert.equal(outcome.problems[0]!.file, 'web/main.tsx');
    assert.match(outcome.problems[0]!.message, /"lodash" is not available: apps cannot install packages/);
    const broken = await runner.migrate('basic/live', [{ name: '002.sql', sql: 'CREATE TABLE notes (again)' }]);
    assert.deepEqual(broken, { ok: false, migration: '002.sql', message: 'table notes already exists' });
  });

  it('kills what the interpreter cannot stop, and loses nothing but that call', async () => {
    const notes = await deploy(runner, 'kills');
    await notes.call('add', { body: 'avant' });
    for (const fn of ['endlessSql', 'endlessWrite', 'stubbornMemory', 'slowSteps']) {
      const started = Date.now();
      const result = await notes.call(fn);
      assert.ok(!result.ok && result.error.code === 'timeout', `${fn}: ${JSON.stringify(result)}`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < LIMITS.callMs + LIMITS.killGraceMs + 1_500, `${fn} was stopped after ${elapsed} ms`);
    }
    // The interrupted write left nothing, and the app works again at once.
    assert.equal(valueOf(await notes.call('count')), 1);
    assert.equal(valueOf(await notes.call('add', { body: 'après' })), 2);
  });

  it('kills a worker whose memory grows past its allowance, whatever is holding it', async () => {
    const tight = localRunner({
      appsDir: path.join(dir, 'tight'),
      limits: { ...LIMITS, callMs: 5_000, workerMemory: 220 * 1024 * 1024 },
      workers: 1,
    });
    try {
      const notes = await deploy(tight, 'heavy');
      const result = await notes.call('heavySql');
      if (process.platform === 'linux') {
        assert.deepEqual(result, {
          ok: false,
          error: { code: 'memory', message: 'the function used too much memory and was stopped' },
          logs: [],
        });
      }
      assert.equal(valueOf(await notes.call('count')), 0, 'and the app works again at once');
    } finally {
      await tight.close();
    }
  });

  it('one stuck app does not block the others', async () => {
    // A long deadline, so that the stuck call is still stuck however slow this machine starts workers.
    const patient = localRunner({
      appsDir: path.join(dir, 'patient'),
      limits: { ...LIMITS, callMs: 4_000 },
      workers: 2,
    });
    try {
      const stuck = await deploy(patient, 'stuck');
      const fine = await deploy(patient, 'fine');
      let stopped = false;
      const blocked = stuck.call('endlessSql').then((result) => {
        stopped = true;
        return result;
      });
      const answers = await Promise.all(
        Array.from({ length: 5 }, (_, index) => fine.call('add', { body: `note ${index}` })),
      );
      assert.ok(answers.every((answer) => answer.ok));
      assert.equal(stopped, false, 'the other worker served them while the first was still stuck');
      assert.equal(valueOf(await fine.call('count')), 5);
      assert.equal((await blocked).ok, false);
    } finally {
      await patient.close();
    }
  });
});

describe('the worker pool', () => {
  // A call the runner answers at once: it does not know that code.
  const quick = (database = 'nobody/live') => ({
    type: 'call' as const,
    request: {
      database,
      bundleHash: '0'.repeat(64),
      fn: 'x',
      inputJson: 'null',
      user: null,
      members: [],
      now: 0,
      today: '',
    },
  });

  it('refuses new jobs when too many are waiting, and when closed', async () => {
    const pool = new WorkerPool({ appsDir: path.join(dir, 'pool'), limits: LIMITS, size: 1, maxQueue: 3 });
    const jobs = Array.from({ length: 6 }, () =>
      pool.run(quick()).then(
        (result) => (result.ok ? 'ok' : result.error.code),
        (error: PoolFailure) => error.code,
      ),
    );
    assert.deepEqual((await Promise.all(jobs)).sort(), [
      'bundle_missing',
      'bundle_missing',
      'bundle_missing',
      'busy',
      'busy',
      'busy',
    ]);
    assert.equal(pool.stats().workers, 1);
    await pool.close();
    await assert.rejects(pool.run(quick()), (error) => error instanceof PoolFailure && error.code === 'closed');
  });

  it('starts a new worker after a kill', async () => {
    const pool = new WorkerPool({ appsDir: path.join(dir, 'respawn'), limits: LIMITS, size: 1 });
    try {
      const built = await pool.run({ type: 'build', files: SOURCE });
      assert.ok(built.ok);
      await pool.run({ type: 'migrate', database: 'respawn/live', migrations: built.app.migrations });
      const { hash } = await pool.run({ type: 'install', app: 'respawn', bundle: built.app.server!.bundle });
      const call = (fn: string) =>
        pool.run({
          type: 'call',
          request: {
            database: 'respawn/live',
            bundleHash: hash,
            fn,
            inputJson: 'null',
            user: null,
            members: [],
            now: 0,
            today: '',
          },
        });
      await assert.rejects(call('endlessSql'), (error) => error instanceof PoolFailure && error.code === 'timeout');
      assert.deepEqual(pool.stats(), { workers: 0, busy: 0, queued: 0, killed: 1 });
      assert.deepEqual(await call('count'), { ok: true, kind: 'query', json: '0', effects: [], logs: [] });
      assert.equal(pool.stats().workers, 1);
    } finally {
      await pool.close();
    }
  });

  it('fails only the job that cannot be sent to a worker', async () => {
    const pool = new WorkerPool({ appsDir: path.join(dir, 'unsendable'), limits: LIMITS, size: 1 });
    try {
      assert.ok('error' in (await pool.run(quick())));
      // A value that cannot be written as JSON: nothing the web side sends, but nothing here may depend on that.
      const unsendable = { ...quick(), request: { ...quick().request, now: 10n as unknown as number } };
      const outcomes = await Promise.all(
        [quick(), unsendable, quick(), unsendable, quick()].map((job) =>
          pool.run(job).then(
            () => 'answered',
            (error: PoolFailure) => `${error.code}: ${error.message}`,
          ),
        ),
      );
      const unsent = 'crashed: this job could not be sent to a worker';
      assert.deepEqual(outcomes, ['answered', unsent, 'answered', unsent, 'answered']);
      assert.deepEqual(pool.stats(), { workers: 1, busy: 0, queued: 0, killed: 0 });
    } finally {
      await pool.close();
    }
  });

  it('gives every build a process of its own, so a source that breaks the bundler breaks nothing else', async () => {
    const pool = new WorkerPool({ appsDir: path.join(dir, 'builds'), limits: LIMITS, size: 1 });
    try {
      const good = await pool.run({ type: 'build', files: SOURCE });
      assert.ok(good.ok);
      // Files no person would write: refused by name of the problem, before any parser sees them.
      const deep = await pool.run({
        type: 'build',
        files: { ...SOURCE, 'web/deep.ts': `export const x = ${'['.repeat(5_000)}${']'.repeat(5_000)};` },
      });
      assert.ok(
        !deep.ok && deep.problems.some((problem) => /nested more than 500 deep/.test(problem.message)),
        JSON.stringify(deep),
      );
      const wide = await pool.run({ type: 'build', files: { ...SOURCE, 'web/wide.ts': 'x==-0;'.repeat(16_000) } });
      assert.ok(!wide.ok && /longer than 5000 characters/.test(wide.problems[0]!.message), JSON.stringify(wide));
      // Many small mistakes: answered with a few of them, not with the whole file once per mistake.
      const noisy = await pool.run({
        type: 'build',
        files: {
          ...SOURCE,
          'web/noisy.ts': 'x==-0;\n'.repeat(5_000),
          'web/main.tsx': 'import "./noisy"; export default () => null;',
        },
      });
      assert.ok(noisy.ok && noisy.app.warnings.length <= 20, JSON.stringify(noisy).slice(0, 300));
      // Whatever happened in those processes, the next build starts from a new one.
      const again = await pool.run({ type: 'build', files: SOURCE });
      assert.ok(again.ok);
      assert.equal(again.app.web.js, good.app.web.js);
      assert.equal(pool.stats().workers, 0, 'builds never used a call worker');
    } finally {
      await pool.close();
    }
  });
});

describe('the runner behind its socket', () => {
  it('serves the same jobs over a Unix socket only its user can open', async () => {
    const socketPath = path.join(dir, 'run', 'runner.sock');
    const service = await startRunner({ socketPath, appsDir: path.join(dir, 'remote'), limits: LIMITS, workers: 1 });
    const runner = remoteRunner(socketPath, LIMITS);
    try {
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
      assert.equal(await runner.healthy(), true);
      const notes = await deploy(runner, 'remote');
      assert.equal(valueOf(await notes.call('add', { body: 'Pain' })), 1);
      const stopped = await notes.call('spin');
      assert.ok(!stopped.ok && stopped.error.code === 'timeout');
      const vendor = await runner.vendor();
      assert.deepEqual(Object.keys(vendor).sort(), [
        'react-dom.js',
        'react-jsx-runtime.js',
        'react.js',
        'sdk.js',
        'ui.css',
        'ui.js',
      ]);
    } finally {
      await service.close();
    }
    assert.equal(await runner.healthy(), false);
    await assert.rejects(
      runner.build(SOURCE),
      (error) => error instanceof RunnerUnavailable && error.code === 'unreachable',
    );
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));
