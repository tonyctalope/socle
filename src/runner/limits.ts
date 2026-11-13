// Every bound the runner puts on code and data it did not write. They are generous for
// an app shared by a few people and exist so that a wrong or hostile app can only hurt itself.

const KiB = 1024;
const MiB = 1024 * KiB;

export interface Limits {
  /** Wall-clock budget of one function call, loading the app's bundle included. */
  callMs: number;
  /** A build (bundles, CSS), a batch of migrations, the daily copy of one app database. */
  buildMs: number;
  migrateMs: number;
  backupMs: number;
  /** How long after a deadline the supervisor waits before killing the worker process. */
  killGraceMs: number;
  /**
   * Memory of the JavaScript engine one call runs in: the size its WebAssembly memory may
   * grow to (the engine's own accounting does not hold in this build), and its stack.
   */
  guestMemory: number;
  guestStack: number;
  /** What one SQL statement may hand back to the app. */
  maxRows: number;
  maxRowBytes: number;
  /** Size of a function's JSON result and input. */
  maxResultBytes: number;
  maxInputBytes: number;
  /** SQLite: statement length, size of one value, size of one app database. */
  sqlLength: number;
  valueLength: number;
  dbMaxPages: number;
  /**
   * How large the write-ahead log of an app may get before the call writing to it is stopped and
   * undone. With the size of the database, this is what bounds the disk an app can take.
   */
  walBytes: number;
  /** Tables, indexes, views and triggers of one app, and the total size of their definitions. */
  maxSchemaObjects: number;
  maxSchemaBytes: number;
  /**
   * Resident memory of one worker process; past it the process is killed like a call past its
   * deadline. This is what bounds SQLite's own memory (sorts, temporary tables), which SQLite
   * cannot bound itself in Node's build.
   */
  workerMemory: number;
  /** Console lines and notifications kept from one call. */
  maxLogs: number;
  maxLogLength: number;
  maxEffects: number;
}

export const DEFAULT_LIMITS: Limits = {
  callMs: 2_000,
  buildMs: 20_000,
  migrateMs: 30_000,
  backupMs: 120_000,
  killGraceMs: 1_000,
  guestMemory: 64 * MiB,
  guestStack: 256 * KiB,
  maxRows: 10_000,
  maxRowBytes: 8 * MiB,
  maxResultBytes: 4 * MiB,
  maxInputBytes: 256 * KiB,
  sqlLength: 100_000,
  valueLength: 4 * MiB,
  dbMaxPages: 65_536, // 256 MiB with 4 KiB pages
  walBytes: 128 * MiB,
  maxSchemaObjects: 500,
  maxSchemaBytes: 512 * KiB,
  workerMemory: 384 * MiB,
  maxLogs: 50,
  maxLogLength: 2_000,
  maxEffects: 20,
};

/** What an app may send to be built. */
export const SOURCE_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 512 * KiB,
  maxTotalBytes: 3 * MiB,
  maxPathLength: 120,
  /** Code is written by hand or by an agent, not minified: long lines and deep nesting are not code. */
  maxLineLength: 5_000,
  maxNesting: 500,
  maxMigrations: 500,
  maxFunctions: 200,
  /** What a build may produce. */
  maxWebBytes: 3 * MiB,
  maxCssBytes: 1 * MiB,
  maxServerBytes: 2 * MiB,
};
