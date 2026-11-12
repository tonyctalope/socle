import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

export type Db = DatabaseSync;
export type SqlValue = SQLInputValue;
export type Params = Record<string, SqlValue>;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

const open = new WeakSet<Db>();

/** Runs a synchronous fn in a transaction (nested calls join the outer one). */
export function transaction<T>(db: Db, fn: () => T): T {
  if (open.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  open.add(db);
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('transaction() callbacks must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    open.delete(db);
  }
}

const cache = new WeakMap<Db, Map<string, StatementSync>>();

function statement(db: Db, sql: string): StatementSync {
  let statements = cache.get(db);
  if (!statements) {
    statements = new Map();
    cache.set(db, statements);
  }
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

export function get<T>(db: Db, sql: string, params: Params = {}): T | undefined {
  return statement(db, sql).get(params) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: Params = {}): T[] {
  return statement(db, sql).all(params) as T[];
}

export function run(db: Db, sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
  const result = statement(db, sql).run(params);
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

export const bool = (value: boolean): number => (value ? 1 : 0);
