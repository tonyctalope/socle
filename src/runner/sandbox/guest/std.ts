// What an app's server code imports as "@socle/server". This file runs INSIDE the
// sandbox, next to the app's code: it is a convenience for the app, not a guard.
// Everything that protects the platform is enforced on the other side of `host`.
import { SchemaBuilder, v, validate, type Schema } from '../../schema.ts';

/**
 * The only door out of the sandbox: text in, text out. Taken here and then removed from
 * the globals (see engine.ts), so the app's code reaches it through this file only.
 */
const host = (globalThis as unknown as { __host: (op: string, a: string, b: string) => string }).__host;

// Taken before the app's code loads, so that an app which replaces JSON by accident
// still talks to the platform correctly.
const toJson = JSON.stringify;
const fromJson = JSON.parse;

type Kind = 'query' | 'mutation';
type Handler = (context: unknown, input: unknown) => unknown;

interface Definition {
  kind: Kind;
  handler: Handler;
  input: Schema | null;
  tool: string | null;
}

/** An error whose message is meant for the person using the app. */
class UserError extends Error {
  code: string;
  constructor(message: string, code = 'failed') {
    super(message);
    this.name = 'UserError';
    this.code = String(code);
  }
}

class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

class UnknownFunction extends Error {
  constructor(name: string) {
    super(`no server function named "${name}"`);
    this.name = 'UnknownFunction';
  }
}

const definitions = new WeakMap<object, Definition>();

function define(kind: Kind, spec: unknown): object {
  const given = typeof spec === 'function' ? { handler: spec } : (spec as Record<string, unknown> | null);
  if (!given || typeof given.handler !== 'function') {
    throw new TypeError(`${kind}() takes a function, or { input, handler }`);
  }
  let input: Schema | null = null;
  if (given.input !== undefined) {
    if (!(given.input instanceof SchemaBuilder)) throw new TypeError(`${kind}(): input must be built with v.object(…)`);
    input = given.input.schema;
  }
  if (given.tool !== undefined && typeof given.tool !== 'string') {
    throw new TypeError(`${kind}(): tool is the description Claude reads, as text`);
  }
  const marker = Object.freeze({ kind });
  definitions.set(marker, { kind, handler: given.handler as Handler, input, tool: (given.tool as string) ?? null });
  return marker;
}

function exported(name: string): Definition | undefined {
  const app = (globalThis as { __app?: Record<string, unknown> }).__app;
  const value = app && Object.hasOwn(app, name) ? app[name] : undefined;
  return typeof value === 'object' && value !== null ? definitions.get(value) : undefined;
}

function sql(op: 'all' | 'get' | 'run', text: unknown, params: unknown[]): unknown {
  if (typeof text !== 'string') throw new TypeError(`db.${op}: the SQL must be text`);
  return fromJson(host(op, text, toJson(params)));
}

const db = Object.freeze({
  /** Every row, as objects. */
  all: (text: string, ...params: unknown[]) => sql('all', text, params),
  /** The first row, or null. */
  get: (text: string, ...params: unknown[]) => sql('get', text, params),
  /** For INSERT, UPDATE and DELETE: { changes, lastInsertRowid }. */
  run: (text: string, ...params: unknown[]) => sql('run', text, params),
});

function print(level: string) {
  return (...parts: unknown[]) => {
    const text = parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part instanceof Error) return `${part.name}: ${part.message}`;
        try {
          return toJson(part);
        } catch {
          return String(part);
        }
      })
      .join(' ');
    host('log', level, text);
  };
}

(globalThis as Record<string, unknown>).console = Object.freeze({
  log: print('log'),
  info: print('info'),
  warn: print('warn'),
  error: print('error'),
  debug: print('debug'),
});

interface CallContext {
  user: { id: number; name: string } | null;
  members: { id: number; name: string }[];
  now: number;
  today: string;
}

function invoke(name: string, contextJson: string, inputJson: string): string | Promise<string> {
  const definition = exported(name);
  if (!definition) throw new UnknownFunction(name);
  const input: unknown = fromJson(inputJson);
  if (definition.input) {
    const problem = validate(definition.input, input);
    if (problem) throw new InputError(problem);
  }
  const given = fromJson(contextJson) as CallContext;
  const effects: unknown[] = [];
  const context = Object.freeze({
    db,
    /** Who is calling: { id, name }. Null when the platform runs the function on a schedule. */
    user: given.user,
    /** Everyone who can open the app: [{ id, name }]. */
    members: given.members,
    /** The time of the call in milliseconds, and today's date (YYYY-MM-DD) where the household lives. */
    now: given.now,
    today: given.today,
    /** Sends a notification once the call has succeeded. `to`: a user id, a list of ids, "others" or "all". */
    notify(to: unknown, message: unknown) {
      effects.push({ type: 'notify', to, message });
    },
  });
  const finish = (value: unknown) => toJson({ value: value === undefined ? null : value, effects });
  const result = definition.handler(context, input);
  if (typeof result === 'object' && result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
    return Promise.resolve(result).then(finish);
  }
  return finish(result);
}

function describe(): string {
  const app = (globalThis as { __app?: Record<string, unknown> }).__app ?? {};
  const functions = [];
  for (const name of Object.keys(app)) {
    const definition = exported(name);
    if (definition) functions.push({ name, kind: definition.kind, input: definition.input, tool: definition.tool });
  }
  return toJson(functions);
}

function fail(message: string, code?: string): never {
  throw new UserError(message, code);
}

export const socle = Object.freeze({
  query: (spec: unknown) => define('query', spec),
  mutation: (spec: unknown) => define('mutation', spec),
  v,
  fail,
  UserError,
  __kind: (name: string) => exported(name)?.kind ?? '',
  __invoke: invoke,
  __describe: describe,
});
