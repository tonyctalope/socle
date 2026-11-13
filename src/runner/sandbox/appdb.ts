import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import type { Limits } from '../limits.ts';

// One SQLite file per app, opened here and nowhere else. The app never chooses a
// path: it names nothing but its own tables, through statements that are checked
// when SQLite compiles them (the authorizer below). What no statement may do,
// whoever wrote it: reach another file (ATTACH is also disabled outright), change
// a setting (PRAGMA), load code (extensions), or end the transaction the platform
// opened around the call.

const C = constants;

/** "<app>/<name>", e.g. "tricount/live". Nothing else ever becomes part of a path. */
const DATABASE_NAME = /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,15}$/;

/** Tables the platform keeps inside an app's database, hidden from the app. */
const PLATFORM_PREFIX = '_socle_';

export class SqlRefused extends Error {}

export function databaseFile(appsDir: string, database: string): string {
  if (!DATABASE_NAME.test(database)) throw new SqlRefused(`invalid database name: ${database}`);
  return path.join(appsDir, `${database}.db`);
}

type Mode = 'call' | 'migrate';

interface Guard {
  /** True while SQL written by an app is being compiled; the platform's own statements skip the checks. */
  guest: boolean;
  /** What the last refused statement tried to do, for the error message. */
  denied: string | null;
  /**
   * During a call: the tables and views of the app, the only things a statement may read
   * besides the few names of READABLE. Null in a migration, where the schema is changing.
   */
  tables: Set<string> | null;
}

/** SQLITE_CREATE_TABLE → "CREATE TABLE", for error messages. */
const ACTION_NAMES = new Map<number, string>(
  Object.entries(C)
    .filter(([name]) => name.startsWith('SQLITE_') && !/^SQLITE_(OK|DENY|IGNORE|CHANGESET_)/.test(name))
    .map(([name, code]) => [code as number, name.slice('SQLITE_'.length).replaceAll('_', ' ')]),
);

const WRITES = new Set<number>([C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE]);
const SCHEMA_CHANGES = new Set<number>([
  C.SQLITE_CREATE_TABLE,
  C.SQLITE_CREATE_INDEX,
  C.SQLITE_CREATE_VIEW,
  C.SQLITE_CREATE_TRIGGER,
  C.SQLITE_DROP_TABLE,
  C.SQLITE_DROP_INDEX,
  C.SQLITE_DROP_VIEW,
  C.SQLITE_DROP_TRIGGER,
  C.SQLITE_ALTER_TABLE,
]);
const REFUSED_FUNCTIONS = new Set(['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer']);

const isInternal = (name: string | null) => name !== null && name.toLowerCase().startsWith('sqlite_');
const isPlatform = (name: string | null) => name !== null && name.toLowerCase().startsWith(PLATFORM_PREFIX);

/** Readable without being a table of the app: the schema itself, and JSON values unfolded as rows. */
const READABLE = new Set(['sqlite_master', 'sqlite_schema', 'json_each', 'json_tree']);

/**
 * Tables that exist without having been created: SQLite builds some in (storage internals,
 * tokenizers), native code no app needs. They are refused by name, from the list of this very
 * build (`PRAGMA module_list`) plus the ones a build can have without listing them.
 */
const builtIn = new Set([
  'sqlite_dbpage',
  'sqlite_stmt',
  'sqlite_memstat',
  'bytecode',
  'tables_used',
  'generate_series',
]);
let builtInListed = false;

function listBuiltIn(db: DatabaseSync): void {
  if (builtInListed) return;
  for (const row of db.prepare('PRAGMA module_list').all() as { name: string }[]) builtIn.add(row.name.toLowerCase());
  builtInListed = true;
}

const isBuiltIn = (name: string) => name.startsWith('pragma_') || builtIn.has(name);

function decide(
  mode: Mode,
  guard: Guard,
  action: number,
  first: string | null,
  second: string | null,
  schema: string | null,
): boolean {
  if (schema !== null && schema !== 'main') {
    // No temporary or attached schema. One exception: renaming a table or a column makes
    // SQLite fix up the (empty) temporary schema as well.
    const fixup = mode === 'migrate' && schema === 'temp' && (first ?? '').toLowerCase() === 'sqlite_temp_master';
    return fixup && (action === C.SQLITE_READ || action === C.SQLITE_UPDATE);
  }
  if (action === C.SQLITE_SELECT || action === C.SQLITE_RECURSIVE) return true;
  if (action === C.SQLITE_FUNCTION) return !REFUSED_FUNCTIONS.has((second ?? '').toLowerCase());
  if (action === C.SQLITE_READ) {
    // The platform's own tables are not the app's business.
    const name = (first ?? '').toLowerCase();
    if (isPlatform(name)) return false;
    if (READABLE.has(name)) return true;
    if (isBuiltIn(name)) return false;
    // During a call, a table of the database must be one of the app's (or SQLite's bookkeeping,
    // like sqlite_sequence). Without a schema name it is a sub-query the statement named itself.
    if (guard.tables && schema === 'main') return guard.tables.has(name) || isInternal(name);
    return true;
  }
  if (WRITES.has(action)) {
    if (isPlatform(first)) return false;
    // SQLite records schema changes by writing its own tables: only a migration gets there.
    return isInternal(first) ? mode === 'migrate' : true;
  }
  if (mode !== 'migrate') return false;
  // Statistics and index rebuilds change no data, whatever the table.
  if (action === C.SQLITE_ANALYZE || action === C.SQLITE_REINDEX) return true;
  if (SCHEMA_CHANGES.has(action)) {
    // ALTER TABLE passes (schema, table). The others pass the object's name, then for indexes and
    // triggers the table they sit on: neither may be one of the platform's. Names starting with
    // sqlite_ are SQLite's own (automatic indexes); it refuses them itself from anyone else.
    if (action === C.SQLITE_ALTER_TABLE) return !isPlatform(second);
    return !isPlatform(first) && !isPlatform(second);
  }
  // PRAGMA, ATTACH, DETACH, BEGIN/COMMIT/ROLLBACK, SAVEPOINT, temporary objects, and every virtual
  // table (full-text search included: a large native surface that no app needs yet).
  return false;
}

function authorizer(mode: Mode, guard: Guard) {
  return (action: number, first: string | null, second: string | null, schema: string | null): number => {
    if (!guard.guest || decide(mode, guard, action, first, second, schema)) return C.SQLITE_OK;
    guard.denied = [ACTION_NAMES.get(action) ?? 'this statement', first, second].filter(Boolean).join(' ');
    return C.SQLITE_DENY;
  };
}

export interface Connection {
  db: DatabaseSync;
  guard: Guard;
  file: string;
}

function connect(file: string, mode: Mode, readOnly: boolean, limits: Limits): Connection {
  const db = new DatabaseSync(file, {
    readOnly,
    timeout: 2_000,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    // SQLite cannot bound its own memory here (Node builds it without memory statistics, so
    // hard_heap_limit is accepted and ignored): the pool watches each worker's memory instead.
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // The log is cut back to this once its content is in the database file.
      db.exec(`PRAGMA journal_size_limit = ${Math.min(8 * 1024 * 1024, limits.walBytes)}`);
    }
    listBuiltIn(db);
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec(`PRAGMA max_page_count = ${limits.dbMaxPages}`);
    if (readOnly) db.exec('PRAGMA query_only = ON');
    db.enableDefensive(true);
    Object.assign(db.limits, {
      attach: 0,
      length: limits.valueLength,
      sqlLength: limits.sqlLength,
      column: 200,
      exprDepth: 100,
      compoundSelect: 100,
      functionArg: 100,
      likePatternLength: 1_000,
      variableNumber: 999,
      triggerDepth: 16,
    });
    const guard: Guard = { guest: false, denied: null, tables: null };
    db.setAuthorizer(authorizer(mode, guard));
    return { db, guard, file };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The two handles a worker keeps per app database: one that can write, one that cannot. */
export interface AppDb {
  write: Connection;
  read: Connection;
}

const MAX_OPEN = 24;

export class AppDatabases {
  private readonly appsDir: string;
  private readonly limits: Limits;
  private readonly open = new Map<string, AppDb>();

  constructor(appsDir: string, limits: Limits) {
    this.appsDir = appsDir;
    this.limits = limits;
  }

  get(database: string): AppDb {
    const known = this.open.get(database);
    if (known) {
      // Re-insert to keep the map ordered by last use.
      this.open.delete(database);
      this.open.set(database, known);
      return known;
    }
    const file = databaseFile(this.appsDir, database);
    mkdirSync(path.dirname(file), { recursive: true });
    const write = connect(file, 'call', false, this.limits);
    let read: Connection;
    try {
      read = connect(file, 'call', true, this.limits);
    } catch (error) {
      write.db.close();
      throw error;
    }
    const entry = { write, read };
    this.open.set(database, entry);
    if (this.open.size > MAX_OPEN) {
      const [oldest] = this.open.keys();
      if (oldest !== undefined) this.close(oldest);
    }
    return entry;
  }

  close(database: string): void {
    const entry = this.open.get(database);
    if (!entry) return;
    this.open.delete(database);
    for (const connection of [entry.read, entry.write]) {
      try {
        connection.db.close();
      } catch {
        // already closed
      }
    }
  }

  closeAll(): void {
    for (const database of [...this.open.keys()]) this.close(database);
  }

  /** A separate, short-lived handle on which schema changes are allowed. */
  migrator(database: string): Connection {
    const file = databaseFile(this.appsDir, database);
    mkdirSync(path.dirname(file), { recursive: true });
    return connect(file, 'migrate', false, this.limits);
  }
}

/** Runs SQL written by an app: the checks are on from compilation to the last row. */
export function asGuest<T>(connection: Connection, fn: () => T): T {
  const { guard } = connection;
  guard.guest = true;
  guard.denied = null;
  try {
    return fn();
  } catch (error) {
    throw new Error(sqlMessage(error, guard.denied));
  } finally {
    guard.guest = false;
  }
}

/**
 * ROLLBACK also exists as a way to resolve a conflict (INSERT OR ROLLBACK, ON CONFLICT
 * ROLLBACK, RAISE(ROLLBACK)): not a statement, so never shown to the authorizer, yet it ends
 * the transaction the platform opened. Refused by its name; `transactionEnded` is the check
 * that does not depend on reading SQL.
 */
export function refuseRollback(sql: string): void {
  if (/\brollback\b/i.test(sql)) {
    throw new Error('ROLLBACK is not available, as a statement or as a conflict clause: use ABORT or FAIL');
  }
}

export const transactionEnded = (connection: Connection): boolean => !connection.db.isTransaction;

/** Tells a connection which tables a call may read: those of the app as they are now. */
export function readSchema(connection: Connection): void {
  const rows = connection.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as {
    name: string;
  }[];
  connection.guard.tables = new Set(rows.map((row) => row.name.toLowerCase()));
}

export interface Migration {
  /** File name, e.g. "001_init.sql". Migrations apply in name order, once each. */
  name: string;
  sql: string;
}

export interface MigrationOutcome {
  /** Names applied by this call. */
  applied: string[];
  /** Already in the database but absent from the list (the database is ahead of this version). */
  unknown: string[];
}

export class MigrationError extends Error {
  readonly migration: string;
  constructor(migration: string, message: string) {
    super(message);
    this.migration = migration;
  }
}

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

/** Schema objects named like the platform's, or attached to its table, other than its own. */
const INTRUDERS = `SELECT name FROM sqlite_master
  WHERE (lower(name) LIKE '~_socle~_%' ESCAPE '~' OR lower(tbl_name) LIKE '~_socle~_%' ESCAPE '~')
    AND NOT (tbl_name = '${PLATFORM_PREFIX}migrations' AND (type = 'table' OR name LIKE 'sqlite~_autoindex~_%' ESCAPE '~'))
  LIMIT 1`;

/**
 * Brings an app database up to date. New migrations apply together or not at all;
 * one that was already applied must not have changed since.
 */
export function applyMigrations(
  connection: Connection,
  migrations: readonly Migration[],
  limits: Pick<Limits, 'maxSchemaObjects' | 'maxSchemaBytes'>,
): MigrationOutcome {
  const { db } = connection;
  const names = migrations.map((migration) => migration.name);
  if (names.some((name, index) => index > 0 && name <= names[index - 1]!)) {
    throw new MigrationError(names[0] ?? '', 'migrations must have distinct names, given in ascending order');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${PLATFORM_PREFIX}migrations (
         name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
       ) WITHOUT ROWID`,
    );
    const done = new Map(
      (
        db.prepare(`SELECT name, checksum FROM ${PLATFORM_PREFIX}migrations`).all() as {
          name: string;
          checksum: string;
        }[]
      ).map((row) => [row.name, row.checksum]),
    );
    const record = db.prepare(`INSERT INTO ${PLATFORM_PREFIX}migrations (name, checksum, applied_at) VALUES (?, ?, ?)`);
    const applied: string[] = [];
    const last = [...done.keys()].sort().at(-1);
    for (const migration of migrations) {
      const sum = checksum(migration.sql);
      const previous = done.get(migration.name);
      if (previous !== undefined) {
        if (previous !== sum) {
          throw new MigrationError(
            migration.name,
            'this migration was already applied and has changed since: add a new migration instead of editing it',
          );
        }
        continue;
      }
      if (last !== undefined && migration.name < last) {
        throw new MigrationError(
          migration.name,
          `migrations apply in name order and ${last} is already applied: give the new one a later name`,
        );
      }
      try {
        refuseRollback(migration.sql);
        asGuest(connection, () => db.exec(migration.sql));
      } catch (error) {
        throw new MigrationError(migration.name, (error as Error).message);
      }
      if (transactionEnded(connection)) {
        throw new MigrationError(migration.name, 'a migration cannot end the transaction it runs in');
      }
      // Nothing of the app may carry the platform's prefix or hang on the platform's table (a
      // renamed table, a trigger): what the next statement writes there must be the platform's alone.
      const intruder = db.prepare(INTRUDERS).get() as { name: string } | undefined;
      if (intruder) {
        throw new MigrationError(
          migration.name,
          `names starting with ${PLATFORM_PREFIX} are the platform's (${intruder.name})`,
        );
      }
      record.run(migration.name, sum, new Date().toISOString());
      applied.push(migration.name);
    }
    // Every connection to this database keeps its whole schema in memory, and a copy of the
    // file costs what creating its tables did: a schema is bounded like the data is.
    const schema = db
      .prepare('SELECT COUNT(*) AS objects, COALESCE(SUM(LENGTH(sql)), 0) AS bytes FROM sqlite_master')
      .get() as {
      objects: number;
      bytes: number;
    };
    if (schema.objects > limits.maxSchemaObjects || schema.bytes > limits.maxSchemaBytes) {
      throw new MigrationError(
        applied.at(-1) ?? names.at(-1) ?? '',
        `the schema is too large: ${schema.objects} tables, indexes, views and triggers (limit ${limits.maxSchemaObjects}), ${schema.bytes} characters of definitions (limit ${limits.maxSchemaBytes})`,
      );
    }
    db.exec('COMMIT');
    return { applied, unknown: [...done.keys()].filter((name) => !names.includes(name)).sort() };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction is already gone
    }
    throw error;
  }
}

/** How much the write-ahead log of a database holds right now. */
export function walBytes(connection: Connection): number {
  try {
    return statSync(`${connection.file}-wal`).size;
  } catch {
    return 0;
  }
}

/** After a call was stopped for writing too much: gives the log's space back. */
export function truncateWal(connection: Connection): void {
  try {
    connection.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // another connection is busy with the file: the next checkpoint will do it
  }
}

/**
 * A consistent copy of an app database next to it (backups/<name>-<date>.db), one per
 * day, keeping the last `keep`. Returns the file written, or null when there was nothing
 * to do. The copy only takes its final name once complete: a copy cut short is not a backup.
 */
export function backupDatabase(appsDir: string, database: string, date: string, keep: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SqlRefused(`invalid backup date: ${date}`);
  const file = databaseFile(appsDir, database);
  if (!existsSync(file)) return null;
  const dir = path.join(path.dirname(file), 'backups');
  const name = path.basename(file, '.db');
  const target = path.join(dir, `${name}-${date}.db`);
  if (existsSync(target)) return null;
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.partial')) rmSync(path.join(dir, entry), { force: true });
  }
  const partial = `${target}.partial`;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
  } finally {
    db.close();
  }
  renameSync(partial, target);
  const dated = new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  const old = readdirSync(dir)
    .filter((entry) => dated.test(entry))
    .sort()
    .slice(0, -Math.max(1, keep));
  for (const entry of old) rmSync(path.join(dir, entry), { force: true });
  return target;
}

/** What went wrong with a statement, in words its author can act on. */
function sqlMessage(error: unknown, denied: string | null): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/not authorized/i.test(message)) return message;
  return `not allowed${denied ? `: ${denied}` : ''} — an app reads and writes its own tables only; schema changes belong in migrations/; PRAGMA, ATTACH and transaction statements are not available`;
}
