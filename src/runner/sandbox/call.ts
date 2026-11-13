import type { Limits } from '../limits.ts';
import { schemaProblem, type Schema } from '../schema.ts';
import { asGuest, type AppDatabases, type Connection } from './appdb.ts';
import { createSandbox, GuestFailure, type HostBridge } from './engine.ts';

export interface Member {
  id: number;
  name: string;
}

export interface CallRequest {
  /** "<app>/<name>": which database the function sees. */
  database: string;
  /** The app's server code, as produced by the build. */
  bundle: string;
  fn: string;
  input: unknown;
  /** Null when the platform itself runs the function (a schedule). */
  user: Member | null;
  members: Member[];
  /** Epoch milliseconds, and the date (YYYY-MM-DD) in the household's timezone. */
  now: number;
  today: string;
}

/** A notification the function asked for; sent by the web side once the call has succeeded. */
export interface NotifyEffect {
  type: 'notify';
  to: number[] | 'others' | 'all';
  title: string;
  body: string;
  url: string;
}

export type CallResult =
  | { ok: true; kind: 'query' | 'mutation'; value: unknown; effects: NotifyEffect[]; logs: string[] }
  | { ok: false; error: { code: string; message: string }; logs: string[] };

export interface FunctionInfo {
  name: string;
  kind: 'query' | 'mutation';
  input: Schema | null;
  /** The description Claude reads when the function is offered as a tool. */
  tool: string | null;
}

const FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function toParams(json: string): unknown[] | Record<string, unknown> {
  const params: unknown = JSON.parse(json);
  if (!Array.isArray(params)) throw new Error('invalid parameters');
  const single: unknown = params[0];
  // db.get('… WHERE id = :id', { id }) — one plain object means named parameters.
  if (params.length === 1 && typeof single === 'object' && single !== null && !Array.isArray(single)) {
    return single as Record<string, unknown>;
  }
  return params;
}

function bindable(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL parameters must be finite numbers');
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error('SQL parameters must be text, numbers, booleans or null (store lists and objects as JSON text)');
}

/** The database half of the bridge: one statement of the app, bounded in what it returns. */
function runStatement(connection: Connection, op: string, sql: string, paramsJson: string, limits: Limits): string {
  if (sql.length > limits.sqlLength) throw new Error('SQL statement too long');
  const given = toParams(paramsJson);
  return asGuest(connection, () => {
    const statement = connection.db.prepare(sql);
    const positional = Array.isArray(given) ? given.map(bindable) : [];
    const named = Array.isArray(given)
      ? undefined
      : Object.fromEntries(Object.entries(given).map(([name, value]) => [name, bindable(value)]));
    if (op === 'run') {
      const done = named ? statement.run(named) : statement.run(...positional);
      return JSON.stringify({ changes: Number(done.changes), lastInsertRowid: Number(done.lastInsertRowid) });
    }
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    const wanted = op === 'get' ? 1 : limits.maxRows;
    for (const row of named ? statement.iterate(named) : statement.iterate(...positional)) {
      if (rows.length >= wanted) {
        if (op === 'get') break;
        throw new Error(`the query returns more than ${limits.maxRows} rows: add a LIMIT`);
      }
      for (const value of Object.values(row)) {
        if (typeof value === 'string') bytes += value.length;
        else if (value instanceof Uint8Array) throw new Error('BLOB values cannot be read by server functions');
        else bytes += 8;
      }
      if (bytes > limits.maxRowBytes) throw new Error('the query returns too much data: select fewer rows or columns');
      rows.push(row as Record<string, unknown>);
    }
    return JSON.stringify(op === 'get' ? (rows[0] ?? null) : rows);
  });
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Text from an app, made safe to print on one line of a log. */
function printable(text: string): string {
  return text.replace(CONTROL, ' ');
}

function readEffects(raw: unknown, limits: Limits): NotifyEffect[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > limits.maxEffects) {
    throw new GuestFailure('error', `a function may send at most ${limits.maxEffects} notifications per call`);
  }
  return raw.map((item) => {
    const effect = item as { to?: unknown; message?: { title?: unknown; body?: unknown; url?: unknown } };
    const { to, message } = effect;
    const ids = typeof to === 'number' ? [to] : to;
    const validTo =
      ids === 'others' || ids === 'all' || (Array.isArray(ids) && ids.length <= 50 && ids.every(Number.isSafeInteger));
    if (!validTo || typeof message?.title !== 'string' || !message.title.trim()) {
      throw new GuestFailure(
        'error',
        'notify(to, { title, body, url }): `to` is a user id, a list of ids, "others" or "all", and a title is required',
      );
    }
    // A path inside the app, nothing that a browser could read as another site.
    const url = typeof message.url === 'string' && /^\/(?![/\\])[^\s\\]{0,300}$/.test(message.url) ? message.url : '/';
    return {
      type: 'notify' as const,
      to: ids as NotifyEffect['to'],
      title: message.title.slice(0, 120),
      body: typeof message.body === 'string' ? message.body.slice(0, 400) : '',
      url,
    };
  });
}

/**
 * Runs one server function of an app: fresh sandbox, one transaction. A query gets a
 * handle that cannot write; a mutation commits only if the function returns.
 */
export async function callFunction(databases: AppDatabases, request: CallRequest, limits: Limits): Promise<CallResult> {
  const logs: string[] = [];
  const failed = (code: string, message: string): CallResult => ({
    ok: false,
    error: { code, message: printable(message) },
    logs,
  });
  if (!FUNCTION_NAME.test(request.fn)) return failed('unknown_function', 'no such server function');
  const input = JSON.stringify(request.input ?? null);
  if (input.length > limits.maxInputBytes) return failed('invalid_input', 'input: too large');

  const deadline = Date.now() + limits.callMs;
  let connection: Connection | undefined;
  const bridge: HostBridge = (op, first, second) => {
    if (op === 'log') {
      // What an app prints ends up in the platform's log: one line each, no control characters.
      if (logs.length < limits.maxLogs) logs.push(`${first}: ${printable(second).slice(0, limits.maxLogLength)}`);
      return '';
    }
    if (op !== 'all' && op !== 'get' && op !== 'run') throw new Error('unknown operation');
    if (!connection)
      throw new Error('the database is only available inside a server function, not while the file loads');
    if (Date.now() > deadline) throw new Error('the function ran for too long');
    return runStatement(connection, op, first, second, limits);
  };

  let sandbox;
  try {
    sandbox = await createSandbox(limits, deadline, bridge);
  } catch {
    return failed('internal', 'the sandbox could not start');
  }
  let inTransaction: Connection | undefined;
  try {
    sandbox.run(request.bundle, 'server.js');
    const kind = sandbox.call('__kind', [request.fn], 16);
    if (kind !== 'query' && kind !== 'mutation')
      return failed('unknown_function', `no server function named "${request.fn}"`);

    const pair = databases.get(request.database);
    const target = kind === 'query' ? pair.read : pair.write;
    try {
      target.db.exec(kind === 'query' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    } catch {
      return failed('busy', 'the app is busy, try again in a moment');
    }
    inTransaction = target;
    connection = target;

    const context = JSON.stringify({
      user: request.user,
      members: request.members,
      now: request.now,
      today: request.today,
    });
    const answer = sandbox.call('__invoke', [request.fn, context, input], limits.maxResultBytes);
    connection = undefined;
    let parsed: { value?: unknown; effects?: unknown };
    try {
      parsed = JSON.parse(answer) as typeof parsed;
    } catch {
      return failed('internal', 'unexpected answer from the sandbox');
    }
    const effects = kind === 'mutation' ? readEffects(parsed.effects, limits) : [];
    target.db.exec('COMMIT');
    inTransaction = undefined;
    return { ok: true, kind, value: parsed.value ?? null, effects, logs };
  } catch (error) {
    if (error instanceof GuestFailure) return failed(error.code, error.message);
    console.error('call failed unexpectedly:', error);
    return failed('internal', 'the platform failed to run the function');
  } finally {
    connection = undefined;
    if (inTransaction) {
      try {
        inTransaction.db.exec('ROLLBACK');
      } catch {
        // Nothing to undo; if the handle itself is unusable, reopen it next time.
        databases.close(request.database);
      }
    }
    sandbox.dispose();
  }
}

/** Loads a server bundle without any database and lists the functions it exports. */
export async function describeBundle(bundle: string, limits: Limits): Promise<FunctionInfo[]> {
  const deadline = Date.now() + limits.callMs;
  const sandbox = await createSandbox(limits, deadline, (op) => {
    if (op === 'log') return '';
    throw new Error('the database is only available inside a server function, not while the file loads');
  });
  try {
    sandbox.run(bundle, 'server.js');
    const listed = JSON.parse(sandbox.call('__describe', [], 1024 * 1024)) as FunctionInfo[];
    for (const info of listed) {
      if (!FUNCTION_NAME.test(info.name)) {
        throw new GuestFailure(
          'error',
          `"${info.name}" is not a valid function name (letters, digits and _, starting with a letter)`,
        );
      }
      if (info.input !== null) {
        const problem = schemaProblem(info.input, `${info.name}.input`);
        if (problem) throw new GuestFailure('error', problem);
      }
      if (info.tool !== null && (info.tool.trim().length < 10 || info.tool.length > 1_000)) {
        throw new GuestFailure('error', `${info.name}.tool: the description for Claude must be 10 to 1000 characters`);
      }
    }
    return listed.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    sandbox.dispose();
  }
}
