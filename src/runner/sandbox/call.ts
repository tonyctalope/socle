import type { Limits } from '../limits.ts';
import { schemaProblem, type Schema } from '../schema.ts';
import {
  asGuest,
  readSchema,
  refuseRollback,
  transactionEnded,
  truncateWal,
  walBytes,
  type AppDatabases,
  type Connection,
} from './appdb.ts';
import { createSandbox, GuestFailure, type HostBridge } from './engine.ts';

export interface Member {
  id: number;
  name: string;
}

/** One call of a server function, with the code to run it. */
export interface Invocation {
  /** "<app>/<name>": which database the function sees. */
  database: string;
  /** The app's server code, as produced by the build. */
  bundle: string;
  fn: string;
  /**
   * What the function was published as. A query always runs on the connection that cannot
   * write, whatever the code says about itself by the time it runs.
   */
  kind?: 'query' | 'mutation';
  /** The input, as a value or already as JSON text (`inputJson` wins). */
  input?: unknown;
  inputJson?: string;
  /** Null when the platform itself runs the function (a schedule). */
  user: Member | null;
  members: Member[];
  /** Epoch milliseconds, and the date (YYYY-MM-DD) in the household's timezone. */
  now: number;
  today: string;
}

/**
 * The same call as it travels to the runner: the code is named by its hash, not carried along,
 * and the input is JSON text (text always crosses a process boundary; a deeply nested value
 * may not survive being serialized again).
 */
export type CallRequest = Omit<Invocation, 'bundle' | 'input' | 'inputJson'> & {
  bundleHash: string;
  inputJson: string;
};

/** A notification the function asked for; sent by the web side once the call has succeeded. */
export interface NotifyEffect {
  type: 'notify';
  to: number[] | 'others' | 'all';
  title: string;
  body: string;
  url: string;
}

export type CallResult =
  /** `json` is what the function returned, as JSON text: it goes to the browser as it is. */
  | { ok: true; kind: 'query' | 'mutation'; json: string; effects: NotifyEffect[]; logs: string[] }
  | { ok: false; error: { code: string; message: string }; logs: string[] };

export interface FunctionInfo {
  name: string;
  kind: 'query' | 'mutation';
  input: Schema | null;
  /** The description Claude reads when the function is offered as a tool. */
  tool: string | null;
}

const FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** No form sends data nested like this; parsers, on the other hand, pay for every level. */
const MAX_INPUT_DEPTH = 64;

/** Whether a JSON text nests objects and arrays deeper than `max` (strings are skipped, not parsed). */
function nestsDeeperThan(json: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json.charCodeAt(index);
    if (inString) {
      if (char === 92)
        index += 1; // a backslash escapes the next character
      else if (char === 34) inString = false;
    } else if (char === 34) {
      inString = true;
    } else if (char === 123 || char === 91) {
      depth += 1;
      if (depth > max) return true;
    } else if (char === 125 || char === 93) {
      depth -= 1;
    }
  }
  return false;
}

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
  refuseRollback(sql);
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
      // Names count too: they are written once per row in what goes back to the app.
      for (const [name, value] of Object.entries(row)) {
        bytes += name.length;
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
export async function callFunction(databases: AppDatabases, request: Invocation, limits: Limits): Promise<CallResult> {
  const logs: string[] = [];
  const failed = (code: string, message: string): CallResult => ({
    ok: false,
    error: { code, message: printable(message) },
    logs,
  });
  if (!FUNCTION_NAME.test(request.fn)) return failed('unknown_function', 'no such server function');
  let input: string;
  try {
    input = request.inputJson ?? JSON.stringify(request.input ?? null);
  } catch {
    return failed('invalid_input', 'input: nested too deeply');
  }
  if (input.length > limits.maxInputBytes) return failed('invalid_input', 'input: too large');
  if (nestsDeeperThan(input, MAX_INPUT_DEPTH)) return failed('invalid_input', 'input: nested too deeply');

  const deadline = Date.now() + limits.callMs;
  let connection: Connection | undefined;
  /** Set when the call wrote more than a call may: nothing it does afterwards counts. */
  let flooded = false;
  /** Set when the call ended the platform's transaction: it gets no further statement. */
  let escaped = false;
  let writes = false;
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
    if (flooded) throw new Error('the function wrote too much data in one call');
    if (escaped) throw new Error('the function ended its transaction');
    let answer: string;
    try {
      answer = runStatement(connection, op, first, second, limits);
    } finally {
      // Whatever the statement did or failed to do, the transaction must still be the platform's.
      escaped = transactionEnded(connection);
    }
    // The size of the database is capped, but one transaction can rewrite the same pages over
    // and over into the write-ahead log: that is capped here, whichever method wrote.
    if (writes && walBytes(connection) > limits.walBytes) {
      flooded = true;
      throw new Error('the function wrote too much data in one call');
    }
    return answer;
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

    if (request.kind && request.kind !== kind) {
      return failed(
        'error',
        `${request.fn} was published as a ${request.kind} but is now a ${kind}: publish the app again`,
      );
    }

    const pair = databases.get(request.database);
    const target = kind === 'query' ? pair.read : pair.write;
    try {
      target.db.exec(kind === 'query' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    } catch {
      return failed('busy', 'the app is busy, try again in a moment');
    }
    inTransaction = target;
    readSchema(target);
    writes = kind === 'mutation';
    connection = target;

    const context = JSON.stringify({
      user: request.user,
      members: request.members,
      now: request.now,
      today: request.today,
    });
    const answer = sandbox.call('__invoke', [request.fn, context, input], limits.maxResultBytes);
    connection = undefined;
    let json: string;
    let effects: NotifyEffect[];
    try {
      const parsed = JSON.parse(answer) as { value?: unknown; effects?: unknown };
      if (typeof parsed.value !== 'string') throw new Error('no value');
      JSON.parse(parsed.value); // it must be one JSON value, since it is forwarded as text
      json = parsed.value;
      effects = kind === 'mutation' ? readEffects(parsed.effects, limits) : [];
    } catch (error) {
      if (error instanceof GuestFailure) throw error;
      return failed('internal', 'unexpected answer from the sandbox');
    }
    if (flooded) return failed('error', 'the function wrote too much data in one call');
    if (escaped || transactionEnded(target)) {
      inTransaction = undefined;
      return failed(
        'error',
        'the function ended its transaction: ROLLBACK is not available, even as a conflict clause',
      );
    }
    try {
      target.db.exec('COMMIT');
    } catch (error) {
      // A constraint checked at the end of the transaction (a deferred foreign key), a full disk.
      return failed('error', `the changes could not be saved: ${(error as Error).message}`);
    }
    inTransaction = undefined;
    return { ok: true, kind, json, effects, logs };
  } catch (error) {
    if (error instanceof GuestFailure) return failed(error.code, error.message);
    console.error('call failed unexpectedly:', error);
    return failed('internal', 'the platform failed to run the function');
  } finally {
    connection = undefined;
    if (inTransaction) {
      inTransaction.guard.tables = null;
      try {
        // Already gone if the app ended it: there is then nothing to undo.
        if (!transactionEnded(inTransaction)) inTransaction.db.exec('ROLLBACK');
      } catch {
        // Nothing to undo; if the handle itself is unusable, reopen it next time.
        databases.close(request.database);
      }
      if (flooded) truncateWal(inTransaction);
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
    // This list comes from code that ran next to the app's: every field is checked before it is recorded.
    const listed = JSON.parse(sandbox.call('__describe', [], 1024 * 1024)) as FunctionInfo[];
    if (!Array.isArray(listed)) throw new GuestFailure('error', 'the server code does not describe its functions');
    for (const info of listed) {
      if (typeof info !== 'object' || info === null || typeof info.name !== 'string') {
        throw new GuestFailure('error', 'the server code does not describe its functions');
      }
      if (info.kind !== 'query' && info.kind !== 'mutation') {
        throw new GuestFailure('error', `${info.name}: a function is a query or a mutation`);
      }
      if (info.tool !== null && typeof info.tool !== 'string') {
        throw new GuestFailure('error', `${info.name}.tool: the description for Claude must be text`);
      }
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
