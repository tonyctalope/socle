// The types of "@socle/server", the module an app's server/ files import. The code
// behind it lives in the sandbox (src/runner/sandbox/guest/std.ts); this file only
// describes it, for editors and for whoever writes an app.

declare module '@socle/server' {
  /** A value SQLite can store or return. */
  export type SqlValue = string | number | boolean | null;
  export type Row = Record<string, any>;

  /** The app's own database. Parameters are positional (?, ?) or one object of named ones (:name). */
  export interface Db {
    /** Every row, as objects. */
    all<T = Row>(sql: string, ...params: (SqlValue | undefined)[] | [Record<string, SqlValue | undefined>]): T[];
    /** The first row, or null. */
    get<T = any>(sql: string, ...params: (SqlValue | undefined)[] | [Record<string, SqlValue | undefined>]): T | null;
    /** INSERT, UPDATE, DELETE (mutations only). */
    run(
      sql: string,
      ...params: (SqlValue | undefined)[] | [Record<string, SqlValue | undefined>]
    ): { changes: number; lastInsertRowid: number };
  }

  export interface Member {
    id: number;
    name: string;
  }

  export interface Context {
    db: Db;
    /** Who is calling. */
    user: Member;
    /** Everyone who can open the app. */
    members: Member[];
    /**
     * Time of the call (epoch milliseconds), and in the instance's timezone (APP_TIMEZONE): today's date
     * (YYYY-MM-DD) and the time of day (HH:MM, 24 hours).
     */
    now: number;
    today: string;
    time: string;
    /** The language the instance is set to ("en", "fr"…): the same value as `locale` in `@socle/sdk`. */
    locale: string;
    /**
     * The files members added through the app's screens (`files.upload` in `@socle/sdk`): the app keeps
     * their ids. `files.remove(id)` deletes one, once the mutation has succeeded.
     */
    files: { remove(id: string): void };
    /** Sends a notification once the mutation has succeeded. */
    notify(to: number | number[] | 'others' | 'all', message: { title: string; body?: string; url?: string }): void;
  }

  /** A description of accepted input, built with `v`. */
  export interface Shape<T> {
    min(value: number): Shape<T>;
    max(value: number): Shape<T>;
    /** Text that must be a date written YYYY-MM-DD. */
    date(): Shape<T>;
    /** Shown to Claude when the function is offered as a tool. */
    describe(text: string): Shape<T>;
    optional(): Shape<T | undefined>;
    nullable(): Shape<T | null>;
  }

  type Optional<S> = { [K in keyof S as undefined extends S[K] ? K : never]?: S[K] };
  type Required<S> = { [K in keyof S as undefined extends S[K] ? never : K]: S[K] };

  export const v: {
    string(): Shape<string>;
    number(): Shape<number>;
    int(): Shape<number>;
    boolean(): Shape<boolean>;
    any(): Shape<unknown>;
    enum<const T extends string>(values: readonly T[]): Shape<T>;
    array<T>(items: Shape<T>): Shape<T[]>;
    object<S extends Record<string, Shape<unknown>>>(
      shape: S,
    ): Shape<
      Required<{ [K in keyof S]: S[K] extends Shape<infer T> ? T : never }> &
        Optional<{ [K in keyof S]: S[K] extends Shape<infer T> ? T : never }>
    >;
    union<T extends Shape<unknown>[]>(...options: T): Shape<T[number] extends Shape<infer U> ? U : never>;
  };

  /** What `query()` and `mutation()` return: export it from server/index.ts to make the function callable. */
  export interface ServerFunction {
    readonly kind: 'query' | 'mutation';
  }

  interface Definition<I, R> {
    /** Checked before the function runs; a call that does not fit is refused. */
    input?: Shape<I>;
    /** Offers the function to Claude as a tool, with this description. */
    tool?: string;
    handler: (context: Context, input: I) => R | Promise<R>;
  }

  /** Reads data. Cannot write, and may run at any time to refresh a screen. */
  export function query<I = any, R = unknown>(
    definition: Definition<I, R> | ((context: Context, input: I) => R | Promise<R>),
  ): ServerFunction;

  /** Changes data, in one transaction: everything it wrote is undone if it throws. */
  export function mutation<I = any, R = unknown>(
    definition: Definition<I, R> | ((context: Context, input: I) => R | Promise<R>),
  ): ServerFunction;

  /**
   * A function the platform runs by itself, in the instance's timezone:
   *   schedule({ every: 'day', at: '08:00', handler: ({ db, members, today, notify }) => { … } })
   *   schedule({ every: 'week', on: 'monday', at: '07:30', handler })      schedule({ every: 'hour', handler })
   * It is a mutation without a caller: `user` is null in its context, and nobody can call it.
   * A run that was missed while the platform was down happens once when it is back.
   */
  export function schedule(definition: {
    every: 'hour' | 'day' | 'week';
    /** HH:MM, for 'day' and 'week'. */
    at?: string;
    /** For 'week'. */
    on?: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
    handler: (context: Omit<Context, 'user'> & { user: null }) => unknown;
  }): ServerFunction;

  /** Stops the function with a message meant for the person using the app. */
  export function fail(message: string, code?: string): never;

  export class UserError extends Error {
    code: string;
    constructor(message: string, code?: string);
  }
}
