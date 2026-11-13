import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { bundleServer } from '../src/runner/build/server.ts';
import { DEFAULT_LIMITS, type Limits } from '../src/runner/limits.ts';
import { AppDatabases, applyMigrations, MigrationError } from '../src/runner/sandbox/appdb.ts';
import { callFunction, describeBundle, type CallRequest, type CallResult } from '../src/runner/sandbox/call.ts';

// What an app's server code can and cannot do. Each test writes the code an app
// would send, builds it as the platform does, and calls it in a real sandbox.

const LIMITS: Limits = { ...DEFAULT_LIMITS, callMs: 400, guestMemory: 32 * 1024 * 1024 };
const BOB = { id: 1, name: 'Bob' };
const ALICE = { id: 2, name: 'Alice' };

const dir = mkdtempSync(path.join(tmpdir(), 'socle-sandbox-'));
const databases = new AppDatabases(dir, LIMITS);
after(() => {
  databases.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, author INTEGER NOT NULL);`;

async function app(name: string, source: string, migrations: Record<string, string> = { '001_init.sql': SCHEMA }) {
  const database = `${name}/live`;
  const connection = databases.migrator(database);
  try {
    applyMigrations(
      connection,
      Object.entries(migrations).map(([file, sql]) => ({ name: file, sql })),
      LIMITS,
    );
  } finally {
    connection.db.close();
  }
  const built = await bundleServer({
    'server/index.ts': `import { query, mutation, v, fail } from '@socle/server';\n${source}`,
  });
  const bundle = built!.code;
  const call = (fn: string, input: unknown = null, overrides: Partial<CallRequest> = {}, limits = LIMITS) =>
    callFunction(
      databases,
      {
        database,
        bundle,
        fn,
        input,
        user: BOB,
        members: [BOB, ALICE],
        now: 1_800_000_000_000,
        today: '2027-01-15',
        ...overrides,
      },
      limits,
    );
  return { call, bundle, database };
}

function value(result: CallResult): unknown {
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.code}: ${result.error.message}`);
  return result.ok ? (JSON.parse(result.json) as unknown) : undefined;
}

function refused(result: CallResult, code: string | RegExp, message?: RegExp): void {
  assert.equal(result.ok, false, `expected a refusal, got ${result.ok ? result.json : ''}`);
  if (result.ok) return;
  if (typeof code === 'string') assert.equal(result.error.code, code, result.error.message);
  else assert.match(result.error.code, code, result.error.message);
  if (message) assert.match(result.error.message, message);
}

const NOTES = `
  export const list = query(({ db }) => db.all('SELECT id, body, author FROM notes ORDER BY id'));
  export const count = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM notes').n);
  export const add = mutation({
    input: v.object({ body: v.string().min(1).max(200) }),
    handler: ({ db, user }, { body }) => db.run('INSERT INTO notes (body, author) VALUES (?, ?)', body, user.id),
  });
`;

describe('server functions', () => {
  it('reads and writes the app database, one transaction per call', async () => {
    const notes = await app(
      'basics',
      `${NOTES}
      export const who = query(({ user, members, now, today }) => ({ user, members, now, today }));
      export const byId = query(({ db }, { id }) => db.get('SELECT body FROM notes WHERE id = :id', { id }));
      export const addTwice = mutation(({ db }) => {
        db.run("INSERT INTO notes (body, author) VALUES ('first', 1)");
        fail('Pas deux fois.', 'twice');
      });
      export const crash = mutation(({ db }) => {
        db.run("INSERT INTO notes (body, author) VALUES ('lost', 1)");
        return undefinedVariable + 1;
      });
      export const later = mutation(async ({ db }, { body }) => {
        await null;
        return db.run('INSERT INTO notes (body, author) VALUES (?, 1)', body).changes;
      });
      export const chatty = query(() => { console.log('hello', { a: 1 }); console.warn('careful'); return 1; });
      export const forger = query(() => {
        console.log('first\\n[other-app] add: forged line\\u001b[2K\\r');
        throw new Error('boom\\nGET control / 200');
      });
      export const flags = query(({ db }) => db.get('SELECT ? AS yes, ? AS no, ? AS empty', true, false, undefined));
    `,
    );
    assert.deepEqual(value(await notes.call('add', { body: 'Pain' })), { changes: 1, lastInsertRowid: 1 });
    assert.deepEqual(value(await notes.call('list')), [{ id: 1, body: 'Pain', author: 1 }]);
    assert.deepEqual(value(await notes.call('byId', { id: 1 })), { body: 'Pain' });
    assert.equal(value(await notes.call('byId', { id: 99 })), null);
    assert.deepEqual(value(await notes.call('who')), {
      user: BOB,
      members: [BOB, ALICE],
      now: 1_800_000_000_000,
      today: '2027-01-15',
    });
    assert.deepEqual(value(await notes.call('flags')), { yes: 1, no: 0, empty: null });

    // A function that fails leaves nothing behind, whether it gives up or crashes.
    refused(await notes.call('addTwice'), 'user:twice', /^Pas deux fois\.$/);
    refused(await notes.call('crash'), 'error', /ReferenceError: 'undefinedVariable' is not defined/);
    assert.equal(value(await notes.call('count')), 1);

    // Agents write async functions out of habit: they work, as long as nothing waits on a timer.
    assert.equal(value(await notes.call('later', { body: 'Lait' })), 1);
    assert.equal(value(await notes.call('count')), 2);

    const chatty = await notes.call('chatty');
    assert.deepEqual(chatty.logs, ['log: hello {"a":1}', 'warn: careful']);
    // What an app prints or throws cannot start a new line in the platform's log.
    const forger = await notes.call('forger');
    assert.deepEqual(forger.logs, ['log: first [other-app] add: forged line [2K ']);
    assert.ok(!forger.ok && /^Error: boom GET control \/ 200/.test(forger.error.message), JSON.stringify(forger));
  });

  it('checks the input against the declared shape before the function runs', async () => {
    const notes = await app('inputs', NOTES);
    refused(await notes.call('add', {}), 'invalid_input', /input\.body: required/);
    refused(await notes.call('add', { body: '' }), 'invalid_input', /must not be empty/);
    refused(await notes.call('add', { body: 'x'.repeat(201) }), 'invalid_input', /at most 200/);
    refused(await notes.call('add', { body: 'ok', admin: true }), 'invalid_input', /input\.admin: unknown field/);
    refused(await notes.call('add', 'Pain'), 'invalid_input', /expected an object/);
    refused(await notes.call('add', { body: 'x'.repeat(DEFAULT_LIMITS.maxInputBytes) }), 'invalid_input', /too large/);
    assert.equal(value(await notes.call('count')), 0);
  });

  it('only exposes what the app exported as a query or a mutation', async () => {
    const notes = await app(
      'exports',
      `${NOTES}
      export const helper = () => 'not a function of the app';
      export const secret = 42;
      const hidden = query(() => 1);
    `,
    );
    for (const name of [
      'helper',
      'secret',
      'hidden',
      'toString',
      'constructor',
      '__proto__',
      'nope',
      '',
      'a b',
      '../x',
    ]) {
      refused(await notes.call(name), 'unknown_function');
    }
    assert.deepEqual(
      (await describeBundle(notes.bundle, LIMITS)).map((fn) => `${fn.kind} ${fn.name}`),
      ['mutation add', 'query count', 'query list'],
    );
  });

  it('describes functions: kind, input shape, description for Claude', async () => {
    const built = await bundleServer({
      'server/index.ts': `
        import { mutation, query, v } from '@socle/server';
        import { MAX } from '../shared/limits';
        export const addExpense = mutation({
          tool: 'Adds an expense to the shared account.',
          input: v.object({
            label: v.string().min(1).max(MAX).describe('What was bought'),
            cents: v.int().min(1),
            day: v.string().date().optional(),
            split: v.array(v.int()).max(10).optional(),
            kind: v.enum(['courses', 'loyer']).nullable(),
          }),
          handler: () => null,
        });
        export const total = query(() => 0);
      `,
      'shared/limits.ts': 'export const MAX = 80;',
    });
    assert.deepEqual(await describeBundle(built!.code, LIMITS), [
      {
        name: 'addExpense',
        kind: 'mutation',
        tool: 'Adds an expense to the shared account.',
        schedule: null,
        input: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'cents', 'kind'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 80, description: 'What was bought' },
            cents: { type: 'integer', minimum: 1 },
            day: { type: 'string', format: 'date' },
            split: { type: 'array', items: { type: 'integer' }, maxItems: 10 },
            kind: { anyOf: [{ type: 'string', enum: ['courses', 'loyer'] }, { type: 'null' }] },
          },
        },
      },
      { name: 'total', kind: 'query', input: null, tool: null, schedule: null },
    ]);
  });

  it('refuses a description of the functions that is not one', async () => {
    // The list is produced by code running next to the app's, which can interfere with it.
    const forged = (replacement: string) =>
      bundleServer({
        'server/index.ts': `
          import { query } from '@socle/server';
          const real = WeakMap.prototype.get;
          WeakMap.prototype.get = function (key) { const found = real.call(this, key); return found && found.handler ? { ...found, ${replacement} } : found; };
          export const f = query(() => 1);`,
      });
    for (const replacement of ["kind: 'admin'", 'kind: null', 'tool: 42', 'tool: { toString() { return "x" } }']) {
      const built = await forged(replacement);
      await assert.rejects(describeBundle(built!.code, LIMITS), /query or a mutation|must be text/, replacement);
    }
  });

  it('collects the notifications a mutation asks for', async () => {
    const notes = await app(
      'notify',
      `
      export const ping = mutation(({ notify, user }) => {
        notify('others', { title: user.name + ' added a note', body: 'Pain', url: '/notes/1' });
        notify(2, { title: 'Pour toi' });
        notify([1, 2], { title: 'Ailleurs', url: 'https://evil.example/' });
        notify(1, { title: 'Ailleurs aussi', url: '//evil.example/x' });
        notify(1, { title: 'Encore', url: '/\\\\evil.example' });
      });
      export const quiet = query(({ notify }) => { notify('all', { title: 'Lu' }); return 1; });
      export const flood = mutation(({ notify }) => { for (let i = 0; i < 100; i++) notify('all', { title: 'Encore' }); });
      export const vague = mutation(({ notify }) => notify('everyone', { title: 'x' }));
    `,
    );
    const ping = await notes.call('ping');
    assert.deepEqual(ping.ok && ping.effects, [
      { type: 'notify', to: 'others', title: 'Bob added a note', body: 'Pain', url: '/notes/1' },
      { type: 'notify', to: [2], title: 'Pour toi', body: '', url: '/' },
      { type: 'notify', to: [1, 2], title: 'Ailleurs', body: '', url: '/' }, // only paths of the app
      { type: 'notify', to: [1], title: 'Ailleurs aussi', body: '', url: '/' },
      { type: 'notify', to: [1], title: 'Encore', body: '', url: '/' },
    ]);
    const quiet = await notes.call('quiet');
    assert.deepEqual(quiet.ok && quiet.effects, [], 'reading something never notifies anyone');
    refused(await notes.call('flood'), 'error', /at most 20 notifications/);
    refused(await notes.call('vague'), 'error', /notify\(to/);
  });
});

describe('what an app cannot do with its database', () => {
  it('a query cannot write', async () => {
    const notes = await app(
      'readonly',
      `${NOTES}
      export const sneaky = query(({ db }) => db.run("INSERT INTO notes (body, author) VALUES ('x', 1)"));
      export const wipe = query(({ db }) => db.run('DELETE FROM notes'));
    `,
    );
    await notes.call('add', { body: 'Pain' });
    refused(await notes.call('sneaky'), 'error', /readonly|read-only|not authorized/i);
    refused(await notes.call('wipe'), 'error', /readonly|read-only|not authorized/i);
    assert.equal(value(await notes.call('count')), 1);
  });

  it('cannot end, restart or nest the transaction of its call', async () => {
    const statements = [
      'COMMIT',
      'END',
      'ROLLBACK',
      'BEGIN',
      'BEGIN IMMEDIATE',
      'SAVEPOINT s',
      'RELEASE s',
      'ROLLBACK TO s',
    ];
    const notes = await app(
      'transactions',
      `${NOTES}
      export const early = mutation(({ db }, { sql }) => {
        db.run("INSERT INTO notes (body, author) VALUES ('ghost', 1)");
        try { db.run(sql); } catch (error) { fail(error.message, 'sql'); }
        throw new Error('boom');
      });
    `,
    );
    for (const sql of statements)
      refused(
        await notes.call('early', { sql }),
        'user:sql',
        /^(not allowed: (TRANSACTION|SAVEPOINT) |ROLLBACK is not available)/,
      );
    assert.equal(value(await notes.call('count')), 0, 'no partial write survived');
  });

  it('cannot end the transaction through a conflict clause either', async () => {
    const source = `${NOTES}
      export const viaClause = mutation(({ db }, { sql }) => {
        db.run("INSERT INTO notes (id, body, author) VALUES (1, 'first', 1)");
        try { db.run(sql); } catch {}
        db.run("INSERT INTO notes (id, body, author) VALUES (2, 'after', 1)");
        throw new Error('boom');
      });
      export const thenReturns = mutation(({ db }, { sql }) => {
        db.run("INSERT INTO notes (id, body, author) VALUES (1, 'first', 1)");
        try { db.run(sql); } catch {}
        try { db.run("INSERT INTO notes (id, body, author) VALUES (2, 'after', 1)"); } catch {}
        return 'done';
      });
      export const wipe = mutation(({ db }) => db.run('DELETE FROM notes').changes);
    `;
    const notes = await app('conflict', source);
    for (const sql of [
      "INSERT OR ROLLBACK INTO notes (id, body, author) VALUES (1, 'again', 1)",
      "insert or RollBack into notes (id, body, author) values (1, 'again', 1)",
      'UPDATE OR ROLLBACK notes SET id = 1 WHERE id = 1',
      "INSERT INTO notes (id, body, author) VALUES (1, 'again', 1) ON CONFLICT (id) DO UPDATE SET body = RAISE(ROLLBACK, 'x')",
    ]) {
      refused(await notes.call('viaClause', { sql }), 'error', /boom/);
      assert.equal(value(await notes.call('count')), 0, `nothing kept after a failed call: ${sql}`);
      // The clause was refused by name, so nothing was ended: what the function then writes is kept or not as a whole.
      assert.equal(value(await notes.call('thenReturns', { sql })), 'done');
      assert.equal(value(await notes.call('count')), 2);
      await notes.call('wipe');
    }
  });

  it('cannot change the schema or the settings outside migrations', async () => {
    const notes = await app(
      'ddl',
      `${NOTES}
      export const attempt = mutation(({ db }, { sql }) => db.all(sql));
    `,
    );
    for (const sql of [
      'CREATE TABLE extra (x)',
      'DROP TABLE notes',
      'ALTER TABLE notes ADD COLUMN x',
      'CREATE INDEX i ON notes(body)',
      'CREATE TEMP TABLE t (x)',
      'CREATE VIEW w AS SELECT 1',
      'CREATE TRIGGER tr AFTER INSERT ON notes BEGIN DELETE FROM notes; END',
      'CREATE VIRTUAL TABLE f USING fts5(x)',
      'PRAGMA journal_mode = DELETE',
      'PRAGMA foreign_keys = OFF',
      'PRAGMA writable_schema = ON',
      'PRAGMA database_list',
      'SELECT * FROM pragma_database_list',
      "SELECT * FROM pragma_table_info('notes')",
      'ANALYZE',
      'REINDEX',
      'VACUUM',
      "UPDATE sqlite_master SET sql = 'x'",
      'DELETE FROM sqlite_sequence',
    ]) {
      refused(await notes.call('attempt', { sql }), 'error');
    }
    // The app can list its tables; the platform's own one shows up there by name only.
    assert.deepEqual(
      value(await notes.call('attempt', { sql: "SELECT name FROM sqlite_master WHERE type = 'table'" })),
      [{ name: '_socle_migrations' }, { name: 'notes' }],
    );
  });

  it('cannot reach another app, a file or native code', async () => {
    const victim = await app('victim', NOTES);
    await victim.call('add', { body: 'secret de victim' });
    const victimFile = path.join(dir, 'victim', 'live.db');
    assert.ok(existsSync(victimFile));
    const thief = await app(
      'thief',
      `${NOTES}
      export const attempt = mutation(({ db }, { sql, params }) => db.all(sql, ...(params ?? [])));
    `,
    );
    for (const [sql, params] of [
      [`ATTACH DATABASE '${victimFile}' AS other`],
      ['ATTACH DATABASE ? AS other', [victimFile]],
      [`ATTACH DATABASE 'file:${victimFile}?mode=ro' AS other`],
      ["ATTACH DATABASE ':memory:' AS mem"],
      ['DETACH DATABASE main'],
      [`VACUUM INTO '${path.join(dir, 'stolen.db')}'`],
      ['VACUUM main INTO ?', [path.join(dir, 'stolen.db')]],
      [`SELECT load_extension('${victimFile}')`],
      ["SELECT load_extension('libc.so.6', 'system')"],
      [`SELECT readfile('${victimFile}')`],
      [`SELECT writefile('${path.join(dir, 'x')}', 'x')`],
      ['SELECT * FROM victim.notes'],
      ['SELECT * FROM other.notes'],
      ['SELECT * FROM temp.sqlite_master'],
      // Tables SQLite has built in, without anyone creating them: storage internals, tokenizers.
      ['SELECT name, pageno FROM dbstat'],
      ["SELECT token FROM fts3tokenize WHERE input = 'hello world'"],
      ['SELECT * FROM sqlite_dbpage'],
      ['SELECT * FROM generate_series(1, 3)'],
      ['SELECT COUNT(*) FROM dbstat'],
      ['WITH pages AS (SELECT * FROM dbstat) SELECT COUNT(*) FROM pages'],
      ['SELECT * FROM _socle_migrations'],
      ["INSERT INTO _socle_migrations VALUES ('x', 'y', 'z')"],
      ['DELETE FROM _socle_migrations'],
      ['DROP TABLE _socle_migrations'],
    ] as [string, unknown[]?][]) {
      refused(await thief.call('attempt', { sql, params }), 'error');
    }
    assert.ok(!existsSync(path.join(dir, 'stolen.db')));
    assert.deepEqual(readdirSync(path.join(dir, 'thief')).sort(), ['live.db', 'live.db-shm', 'live.db-wal']);
    assert.deepEqual(value(await victim.call('list')), [{ id: 1, body: 'secret de victim', author: 1 }]);
    assert.deepEqual(value(await thief.call('list')), []);
    // What stays readable besides the app's own tables: its schema, and JSON unfolded as rows.
    assert.deepEqual(value(await thief.call('attempt', { sql: "SELECT value FROM json_each('[1,2]')" })), [
      { value: 1 },
      { value: 2 },
    ]);
  });

  it('cannot read without bound', async () => {
    const limits = { ...LIMITS, maxRows: 100, maxRowBytes: 50_000, maxResultBytes: 20_000 };
    const notes = await app(
      'bounds',
      `
      export const rows = query(({ db }, { n }) =>
        db.all('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT x FROM c', n).length);
      export const wide = query(({ db }) => db.all("SELECT printf('%.*c', 30000, 'x') AS a, printf('%.*c', 30000, 'y') AS b").length);
      export const first = query(({ db }) => db.get('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c'));
      export const huge = query(({ db }) => db.get('SELECT zeroblob(100000000) AS z'));
      export const blob = query(({ db }) => db.get('SELECT randomblob(8) AS z'));
      export const big = query(() => 'x'.repeat(30000));
      export const longNames = query(({ db }) => db.all('SELECT x AS ' + 'n'.repeat(2000) + ' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50) SELECT x FROM c)').length);
    `,
    );
    const call = (fn: string, input?: unknown) => notes.call(fn, input, {}, limits);
    assert.equal(value(await call('rows', { n: 100 })), 100);
    refused(await call('rows', { n: 101 }), 'error', /more than 100 rows: add a LIMIT/);
    refused(await call('wide'), 'error', /too much data/);
    assert.deepEqual(value(await call('first')), { x: 1 }, 'get() stops at the first row of an endless query');
    refused(await call('huge'), 'error', /too big/);
    refused(await call('blob'), 'error', /BLOB/);
    refused(await call('big'), 'result_too_large');
    refused(await call('longNames'), 'error', /too much data/); // 50 rows × a 2000-character column name
  });

  it('cannot fill the disk: an app database has a maximum size', async () => {
    const limits = { ...LIMITS, dbMaxPages: 64, callMs: 3_000 };
    const small = new AppDatabases(dir, limits);
    try {
      const built = await bundleServer({
        'server/index.ts': `
          import { mutation, query } from '@socle/server';
          export const fill = mutation(({ db }) => {
            for (let i = 0; i < 400; i++) db.run("INSERT INTO blobs (body) VALUES (printf('%.*c', 4000, 'x'))");
          });
          export const count = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM blobs').n);
        `,
      });
      const connection = small.migrator('quota/live');
      applyMigrations(connection, [{ name: '001.sql', sql: 'CREATE TABLE blobs (body TEXT)' }], limits);
      connection.db.close();
      const request = {
        database: 'quota/live',
        bundle: built!.code,
        input: null,
        user: BOB,
        members: [],
        now: 0,
        today: '',
      };
      refused(await callFunction(small, { ...request, fn: 'fill' }, limits), 'error', /full/);
      assert.equal(value(await callFunction(small, { ...request, fn: 'count' }, limits)), 0);
    } finally {
      small.closeAll();
    }
  });
});

describe('what an app cannot do with the machine', () => {
  it('has no access to files, network, processes or the host', async () => {
    const notes = await app(
      'globals',
      `
      export const probe = query(() => ({
        present: ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'Deno', 'Bun',
          'module', 'global', 'Buffer', 'WebAssembly', 'Worker', 'importScripts', 'navigator', 'os', 'std', 'scriptArgs',
          'performance', 'crypto'].filter((name) => typeof globalThis[name] !== 'undefined'),
        door: typeof __host,
      }));
      export const dynamic = query(async () => { const name = 'node:fs'; await import(name); });
      export const viaFunction = query(() => new Function('return typeof process + typeof require')());
      export const viaEval = query(() => (0, eval)('typeof process'));
      export const constructorEscape = query(({ db }) => db.all.constructor('return this')().process === undefined);
      export const errorEscape = query(({ db }) => {
        try { db.all('SELECT * FROM missing'); } catch (error) {
          return { type: Object.prototype.toString.call(error), keys: Object.getOwnPropertyNames(error).sort(), ctor: error.constructor === Error };
        }
      });
    `,
    );
    assert.deepEqual(value(await notes.call('probe')), { present: [], door: 'undefined' });
    refused(await notes.call('dynamic'), 'error');
    assert.equal(value(await notes.call('viaFunction')), 'undefinedundefined');
    assert.equal(value(await notes.call('viaEval')), 'undefined');
    assert.equal(value(await notes.call('constructorEscape')), true);
    // What comes back from the host is a plain error of the sandbox's own realm, with a message and nothing else.
    assert.deepEqual(value(await notes.call('errorEscape')), {
      type: '[object Error]',
      keys: ['message', 'name', 'stack'],
      ctor: true,
    });
  });

  it('is stopped when it loops forever', async () => {
    const notes = await app(
      'loops',
      `${NOTES}
      export const spin = mutation(({ db }) => { db.run("INSERT INTO notes (body, author) VALUES ('ghost', 1)"); for (;;) {} });
      export const spinQuery = query(() => { while (true) {} });
      export const stubborn = mutation(() => { for (;;) { try { for (;;) {} } catch {} } });
      export const asyncSpin = mutation(async () => { for (;;) await null; });
      export const never = mutation(() => new Promise(() => {}));
      export const regex = query(() => /^(a+)+$/.test('a'.repeat(40) + '!'));
      export const slowSql = query(({ db }) => { for (;;) db.get('SELECT 1'); });
    `,
    );
    for (const fn of ['spin', 'spinQuery', 'stubborn', 'asyncSpin', 'regex', 'slowSql']) {
      const started = Date.now();
      refused(await notes.call(fn), 'timeout');
      assert.ok(Date.now() - started < 2_000, `${fn} was stopped in time`);
    }
    refused(await notes.call('never'), 'error', /never settles/);
    assert.equal(value(await notes.call('count')), 0, 'the write of the stopped mutation was rolled back');
    assert.deepEqual(value(await notes.call('add', { body: 'after' })), { changes: 1, lastInsertRowid: 1 });
  });

  it('is stopped when the file itself loops while loading', async () => {
    const looping = await app('toplevel', `for (;;) {}\nexport const ok = query(() => 1);`);
    refused(await looping.call('ok'), 'timeout');
  });

  it('is stopped when it eats memory', async () => {
    const notes = await app(
      'memory',
      `${NOTES}
      export const array = mutation(() => { const all = []; for (;;) all.push(new Array(10000).fill('x')); });
      export const text = mutation(() => { let s = 'x'; for (;;) s += s; });
      export const buffer = mutation(() => new ArrayBuffer(1 << 30).byteLength);
      export const viaSql = mutation(({ db }) => {
        const all = [];
        for (;;) all.push(db.all("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT printf('%.*c', 200, 'x') AS s FROM c"));
      });
    `,
    );
    for (const fn of ['array', 'text', 'buffer', 'viaSql']) refused(await notes.call(fn), /^(memory|error|timeout)$/);
    assert.deepEqual(value(await notes.call('add', { body: 'after' })), { changes: 1, lastInsertRowid: 1 });
  });

  it('cannot hold more memory than a call is given, however it asks', async () => {
    const notes = await app(
      'budget',
      `
      const MiB = 1 << 20;
      const fill = (make) => { const kept = []; let failed = null; try { for (let i = 0; i < 200; i++) kept.push(make(i)); } catch (error) { failed = error.message; } return { kept: kept.length, failed }; };
      export const buffers = query(() => fill(() => new Uint8Array(MiB).fill(1)));
      export const texts = query(() => fill((i) => 'x'.repeat(MiB) + i));
      export const arrays = query(() => fill(() => new Array(MiB / 8).fill(1.5)));
      export const stubborn = query(() => { const kept = []; let refused = 0; for (let i = 0; i < 2000; i++) { try { kept.push(new Uint8Array(MiB).fill(1)); } catch { refused++; } } return { kept: kept.length, refused }; });
      export const fine = query(() => JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ i, s: 'row ' + i }))).length);
    `,
    );
    // 32 MiB for the whole interpreter: none of these gets to keep 200 MiB.
    for (const fn of ['buffers', 'texts', 'arrays']) {
      const { kept, failed } = value(await notes.call(fn)) as { kept: number; failed: string };
      assert.ok(kept < 32, `${fn} kept ${kept} MiB`);
      assert.equal(failed, 'out of memory');
    }
    const stubborn = value(await notes.call('stubborn')) as { kept: number; refused: number };
    assert.ok(stubborn.kept < 32 && stubborn.refused > 1900, JSON.stringify(stubborn));
    assert.equal(value(await notes.call('fine')), 537781);
  });

  it('runs a function as what it was published as', async () => {
    // The code decides what it is each time it loads; what counts is what the build recorded.
    const shifty = await app(
      'shifty',
      `
      const define = globalThis.__socle_loaded_once ? mutation : query;
      const asked = (new Error().stack ?? '').length % 2;
      export const sometimes = (Date.now() % 2 ? query : mutation)(({ db }) => db.run("INSERT INTO notes (body, author) VALUES ('x', 1)").changes);
      export const reader = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM notes').n);
      export const writer = mutation(({ db }) => db.run("INSERT INTO notes (body, author) VALUES ('y', 1)").changes);
    `,
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await shifty.call('sometimes', null, { kind: 'query' });
      assert.equal(result.ok, false, 'published as a query: it never gets to write');
    }
    assert.equal(value(await shifty.call('reader', null, { kind: 'query' })), 0);
    refused(
      await shifty.call('reader', null, { kind: 'mutation' }),
      'error',
      /published as a mutation but is now a query/,
    );
    refused(
      await shifty.call('writer', null, { kind: 'query' }),
      'error',
      /published as a query but is now a mutation/,
    );
    assert.equal(value(await shifty.call('writer', null, { kind: 'mutation' })), 1);
  });

  it('cannot take more disk for its log than it is allowed', async () => {
    const limits = { ...LIMITS, callMs: 5_000, walBytes: 2 * 1024 * 1024 };
    // A table of about 6 MiB, filled by a migration.
    const notes = await app(
      'churn',
      `
      export const rewrite = mutation(({ db }) => db.run('UPDATE notes SET author = author + 1').changes);
      export const stubborn = mutation(({ db }) => { for (;;) { try { db.run('UPDATE notes SET author = author + 1'); } catch {} } });
      export const quietly = mutation(({ db }) => db.all('UPDATE notes SET author = author + 1 RETURNING id').length);
      export const small = mutation(({ db }) => db.run('UPDATE notes SET author = author + 1 WHERE id <= 10').changes);
      export const sum = query(({ db }) => db.get('SELECT SUM(author) AS total, COUNT(*) AS n FROM notes'));
    `,
      {
        '001_init.sql': `${SCHEMA}
          INSERT INTO notes (body, author)
            SELECT printf('%.*c', 3000, 'x'), 1
            FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500) SELECT x FROM c);`,
      },
    );
    const log = path.join(dir, 'churn', 'live.db-wal');
    for (const fn of ['rewrite', 'quietly']) {
      refused(await notes.call(fn, null, {}, limits), 'error', /wrote too much data/);
      assert.ok(statSync(log).size < 1024 * 1024, `${fn}: the log gave its space back`);
    }
    // Catching the refusal does not help: the call gets no further statement, and is undone.
    refused(await notes.call('stubborn', null, {}, limits), /^(error|timeout)$/);
    assert.deepEqual(value(await notes.call('sum')), { total: 1500, n: 1500 }, 'nothing of it was kept');
    assert.equal(value(await notes.call('small', null, {}, limits)), 10);
  });

  it('is stopped when it recurses too deeply, in code or in data', async () => {
    const notes = await app(
      'stack',
      `${NOTES}
      export const recursion = query(() => { const f = () => f() + 1; return f(); });
      export const getter = query(() => { const o = { get x() { return this.x; } }; return o.x; });
      export const nestedParse = query(() => JSON.parse('['.repeat(200000) + ']'.repeat(200000)));
      export const nestedStringify = query(() => { const o = {}; let c = o; for (let i = 0; i < 200000; i++) { c.a = {}; c = c.a; } return JSON.stringify(o).length; });
      export const nestedSource = query(() => eval('('.repeat(100000) + '1' + ')'.repeat(100000)));
      export const nestedResult = query(() => { const o = {}; let c = o; for (let i = 0; i < 200000; i++) { c.a = {}; c = c.a; } return o; });
      export const fine = query(() => { const f = (n) => (n ? f(n - 1) + 1 : 0); return f(500); });
    `,
    );
    for (const fn of ['recursion', 'getter', 'nestedParse', 'nestedStringify', 'nestedSource', 'nestedResult']) {
      refused(await notes.call(fn), /^(stack_overflow|error|memory)$/);
    }
    assert.equal(value(await notes.call('fine')), 500);
    assert.deepEqual(value(await notes.call('add', { body: 'after' })), { changes: 1, lastInsertRowid: 1 });
  });

  it('starts from nothing at every call', async () => {
    const notes = await app(
      'state',
      `
      let counter = 0;
      globalThis.leak = globalThis.leak ?? [];
      export const bump = query(() => { counter += 1; globalThis.leak.push(1); Object.prototype.polluted = true; return [counter, globalThis.leak.length]; });
      export const check = query(() => [counter, typeof globalThis.leak, ({}).polluted === undefined]);
    `,
    );
    assert.deepEqual(value(await notes.call('bump')), [1, 1]);
    assert.deepEqual(value(await notes.call('bump')), [1, 1]);
    assert.deepEqual(value(await notes.call('check')), [0, 'object', true]);
  });

  it('cannot replace what the platform calls inside the sandbox', async () => {
    // The app swaps every global it can reach, while its file loads and again inside a call.
    const sabotage = `
      const fake = { __kind: () => 'mutation', __invoke: () => '{"value":"hijacked","effects":[]}', __describe: () => '[]' };
      for (const attempt of [
        () => { globalThis.__socle.__invoke = fake.__invoke; },
        () => { globalThis.__socle = fake; },
        () => { Object.defineProperty(globalThis, '__socle', { value: fake }); },
        () => { globalThis.__host = () => '[{"id":1,"body":"forged"}]'; },
      ]) { try { attempt(); } catch {} }
    `;
    const notes = await app(
      'swap',
      `${NOTES}
      ${sabotage}
      export const again = query(({ db }) => { ${sabotage} return db.all('SELECT 1 AS one'); });
    `,
    );
    assert.deepEqual(value(await notes.call('list')), []);
    assert.deepEqual(value(await notes.call('again')), [{ one: 1 }]);
    refused(await notes.call('nope'), 'unknown_function');
    assert.deepEqual(
      (await describeBundle(notes.bundle, LIMITS)).map((fn) => fn.name),
      ['add', 'again', 'count', 'list'],
    );
  });

  it('gets an answer of bounded size when it fails, whatever it throws', async () => {
    const notes = await app(
      'loud',
      `
      export const longMessage = query(() => fail('x'.repeat(5_000_000)));
      export const longCode = query(() => fail('Non.', 'c'.repeat(1_000_000)));
      export const oddCode = query(() => fail('Non.', 'a b"<c>'));
      export const longError = query(() => { throw new Error('y'.repeat(5_000_000)); });
      export const longName = query(() => { const e = new Error('z'); e.name = 'N'.repeat(1_000_000); throw e; });
      export const longText = query(() => { throw 't'.repeat(5_000_000); });
      export const longField = mutation({ input: v.object({ a: v.int() }), handler: () => 1 });
      export const getter = query(() => { throw { get message() { return 'g'.repeat(5_000_000); }, name: 'UserError' }; });
    `,
    );
    const cases: [string, unknown?][] = [
      ['longMessage'],
      ['longCode'],
      ['longError'],
      ['longName'],
      ['longText'],
      ['getter'],
      ['longField', { ['k'.repeat(100_000)]: 1 }],
    ];
    for (const [fn, input] of cases) {
      const result = await notes.call(fn, input ?? null);
      assert.ok(!result.ok);
      assert.ok(result.error.message.length <= 2_100, `${fn}: message of ${result.error.message.length} characters`);
      assert.ok(result.error.code.length <= 50, `${fn}: code of ${result.error.code.length} characters`);
    }
    refused(await notes.call('longCode'), 'user:failed', /^Non\.$/);
    refused(await notes.call('oddCode'), 'user:failed');
    refused(await notes.call('longMessage'), 'user:failed', /^x{2000}…$/);
  });

  it('is told why its changes could not be saved', async () => {
    const strict = await app(
      'deferred',
      `export const orphan = mutation(({ db }) => db.run('INSERT INTO children (parent) VALUES (99)').changes);
       export const count = query(({ db }) => db.get('SELECT COUNT(*) AS n FROM children').n);`,
      {
        '001.sql': `CREATE TABLE parents (id INTEGER PRIMARY KEY);
          CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);`,
      },
    );
    refused(await strict.call('orphan'), 'error', /could not be saved: FOREIGN KEY constraint failed/);
    assert.equal(value(await strict.call('count')), 0);
  });

  it('cannot forge what the platform reads back', async () => {
    const notes = await app(
      'forge',
      `
      export const badJson = query(() => { JSON.stringify = () => 'not json'; return 1; });
      export const notText = query(() => { JSON.stringify = () => ({ toString: () => 'x' }); return 1; });
      export const thrower = query(() => { throw { toString() { throw new Error('nope'); }, get message() { throw new Error('nope'); } }; });
      export const throwNumber = query(() => { throw 42; });
      export const hugeError = query(() => { throw new Error('x'.repeat(100000)); });
      export const fakeTimeout = query(() => { const e = new Error('interrupted'); e.name = 'InternalError'; throw e; });
    `,
    );
    // Replacing JSON only breaks the app's own code: the platform kept the real one.
    assert.equal(value(await notes.call('badJson')), 1);
    assert.equal(value(await notes.call('notText')), 1);
    refused(await notes.call('thrower'), 'error');
    refused(await notes.call('throwNumber'), 'error', /42/);
    const huge = await notes.call('hugeError');
    assert.ok(!huge.ok && huge.error.message.length <= 2_000);
    // An app may claim it timed out; that only ever affects its own call.
    refused(await notes.call('fakeTimeout'), 'timeout');
  });
});

describe('migrations', () => {
  const migrate = (database: string, migrations: Record<string, string>, limits: Limits = LIMITS) => {
    const connection = databases.migrator(database);
    try {
      return applyMigrations(
        connection,
        Object.entries(migrations).map(([name, sql]) => ({ name, sql })),
        limits,
      );
    } finally {
      connection.db.close();
    }
  };

  it('apply once, in order, and all together', async () => {
    const first = { '001_init.sql': SCHEMA };
    assert.deepEqual(migrate('migr/live', first), { applied: ['001_init.sql'] });
    assert.deepEqual(migrate('migr/live', first), { applied: [] });

    const second = {
      ...first,
      '002_tags.sql':
        'CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT); ALTER TABLE notes ADD COLUMN tag INTEGER REFERENCES tags(id);',
      '003_broken.sql': "INSERT INTO tags (name) VALUES ('ok'); CREATE TABLE notes (again)",
    };
    assert.throws(
      () => migrate('migr/live', second),
      (error) =>
        error instanceof MigrationError && error.migration === '003_broken.sql' && /already exists/.test(error.message),
    );
    // 002 was part of the failed batch: nothing of it remains.
    const { call } = await app(
      'migr',
      `export const tables = query(({ db }) => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> '_socle_' ORDER BY name").map((row) => row.name));`,
      first,
    );
    assert.deepEqual(value(await call('tables')), ['notes']);

    const fixed = { ...second, '003_broken.sql': "INSERT INTO tags (name) VALUES ('ok')" };
    assert.deepEqual(migrate('migr/live', fixed), { applied: ['002_tags.sql', '003_broken.sql'] });
    assert.deepEqual(value(await call('tables')), ['notes', 'tags']);
  });

  it('refuse a migration edited after it was applied, or slipped in before applied ones', () => {
    migrate('edited/live', { '001_init.sql': SCHEMA, '003_more.sql': 'CREATE TABLE more (x)' });
    assert.throws(
      () => migrate('edited/live', { '001_init.sql': `${SCHEMA} -- changed`, '003_more.sql': 'CREATE TABLE more (x)' }),
      (error) =>
        error instanceof MigrationError && error.migration === '001_init.sql' && /has changed/.test(error.message),
    );
    assert.throws(
      () =>
        migrate('edited/live', {
          '001_init.sql': SCHEMA,
          '002_late.sql': 'CREATE TABLE late (x)',
          '003_more.sql': 'CREATE TABLE more (x)',
        }),
      (error) =>
        error instanceof MigrationError && error.migration === '002_late.sql' && /later name/.test(error.message),
    );
    // Nor may one that ran leave the list: the data would no longer be what the files say.
    assert.throws(
      () => migrate('edited/live', { '001_init.sql': SCHEMA }),
      (error) =>
        error instanceof MigrationError && error.migration === '003_more.sql' && /its file is gone/.test(error.message),
    );
    assert.deepEqual(migrate('edited/live', { '001_init.sql': SCHEMA, '003_more.sql': 'CREATE TABLE more (x)' }), {
      applied: [],
    });
  });

  it('can do what a schema needs', async () => {
    const rich = {
      '001.sql': `
          CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
          CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner INTEGER REFERENCES people(id) ON DELETE SET NULL, done INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX tasks_owner ON tasks(owner);
          CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE done = 0;
          CREATE TRIGGER tasks_touch AFTER UPDATE ON tasks BEGIN UPDATE people SET name = name WHERE id = NEW.owner; END;
          INSERT INTO people (name) VALUES ('Bob'), ('Alice');
          INSERT INTO tasks (title, owner) VALUES ('Poubelles', 1);`,
      '002.sql': `
          ALTER TABLE tasks ADD COLUMN due TEXT;
          ALTER TABLE tasks RENAME COLUMN title TO label;
          ALTER TABLE people RENAME TO members;
          CREATE TABLE scratch (x); DROP TABLE scratch;
          DROP INDEX tasks_owner; CREATE INDEX tasks_owner ON tasks(owner, done);
          ANALYZE;`,
    };
    assert.deepEqual(migrate('rich/live', rich).applied, ['001.sql', '002.sql']);
    const { call } = await app(
      'rich',
      `
      export const open = query(({ db }) => db.all('SELECT label, m.name AS owner FROM open_tasks JOIN members m ON m.id = owner'));
      export const finish = mutation(({ db }, { id }) => db.run('UPDATE tasks SET done = 1 WHERE id = ?', id).changes);
      export const orphan = mutation(({ db }) => db.run("INSERT INTO tasks (label, owner) VALUES ('x', 999)"));
    `,
      rich,
    );
    assert.deepEqual(value(await call('open')), [{ label: 'Poubelles', owner: 'Bob' }]);
    assert.equal(value(await call('finish', { id: 1 })), 1);
    refused(await call('orphan'), 'error', /FOREIGN KEY/);
  });

  it('cannot do what a function cannot do either', () => {
    for (const sql of [
      "ATTACH DATABASE ':memory:' AS other",
      'PRAGMA journal_mode = DELETE',
      'COMMIT',
      'COMMIT; CREATE TABLE after_commit (x)',
      'CREATE TEMP TABLE t (x)',
      'CREATE TABLE _socle_mine (x)',
      'CREATE TABLE mine (x); ALTER TABLE mine RENAME TO _socle_state',
      'CREATE TABLE mine (x); CREATE TRIGGER t AFTER INSERT ON _socle_migrations BEGIN DELETE FROM mine; END',
      'CREATE TABLE mine (x); CREATE TRIGGER t BEFORE INSERT ON _socle_migrations BEGIN SELECT RAISE(IGNORE); END',
      'CREATE TABLE mine (x); CREATE TRIGGER _socle_t AFTER INSERT ON mine BEGIN DELETE FROM mine; END',
      'CREATE INDEX i ON _socle_migrations (name)',
      'CREATE VIEW _socle_view AS SELECT 1 AS x',
      'CREATE TABLE mine (id INTEGER PRIMARY KEY); INSERT INTO mine VALUES (1); INSERT OR ROLLBACK INTO mine VALUES (1)',
      'CREATE TABLE mine (id INTEGER PRIMARY KEY); CREATE TRIGGER t AFTER INSERT ON mine BEGIN SELECT RAISE(ROLLBACK, 1); END',
      'SELECT * FROM dbstat',
      'DROP TABLE _socle_migrations',
      "INSERT INTO _socle_migrations VALUES ('000.sql', 'x', 'y')",
      'CREATE TABLE sqlite_mine (x)',
      "CREATE VIRTUAL TABLE t USING csv(filename='/etc/passwd')",
      'CREATE VIRTUAL TABLE t USING rtree(id, a, b)',
      'CREATE VIRTUAL TABLE t USING fts5(x)',
      'CREATE VIRTUAL TABLE t USING fts5vocab(x, row)',
      'CREATE VIRTUAL TABLE t USING dbstat',
      'PRAGMA data_version',
      "SELECT load_extension('x')",
      `VACUUM INTO '${path.join(dir, 'stolen-by-migration.db')}'`,
    ]) {
      assert.throws(
        () => migrate('strict/live', { '001.sql': sql }),
        (error) => error instanceof MigrationError,
        sql,
      );
    }
    assert.ok(!existsSync(path.join(dir, 'stolen-by-migration.db')));
    assert.deepEqual(migrate('strict/live', { '001.sql': SCHEMA }), { applied: ['001.sql'] });
  });

  it('keep a schema within bounds', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `CREATE TABLE t${index} (id INTEGER PRIMARY KEY, x TEXT);`,
    ).join('\n');
    const tight = { ...LIMITS, maxSchemaObjects: 30 };
    assert.throws(
      () => migrate('wide/live', { '001.sql': many }, tight),
      (error) => error instanceof MigrationError && /schema is too large: 4\d tables/.test(error.message),
    );
    // Refused as a whole: the database is as it was, and a schema that fits goes through.
    assert.deepEqual(migrate('wide/live', { '001.sql': 'CREATE TABLE one (x)' }, tight), {
      applied: ['001.sql'],
    });
    const long = `CREATE TABLE big (${Array.from({ length: 150 }, (_, index) => `column_with_a_long_name_${index} TEXT`).join(', ')});`;
    assert.throws(
      () => migrate('long/live', { '001.sql': long }, { ...LIMITS, maxSchemaBytes: 2_000 }),
      (error) => error instanceof MigrationError && /characters of definitions/.test(error.message),
    );
  });

  it('only accepts database names made of an app and a short name', () => {
    for (const name of [
      '../x/live',
      'a/../../etc',
      '/etc/passwd',
      'app',
      'app/live/x',
      'App/live',
      'app/live.db',
      'a b/live',
      '',
    ]) {
      assert.throws(() => databases.migrator(name), /invalid database name/, name);
      assert.throws(() => databases.get(name), /invalid database name/, name);
    }
  });
});
