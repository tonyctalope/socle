import { buildApp, type BuildOutcome } from './build/build.ts';
import { buildVendor, type VendorFiles } from './build/vendor.ts';
import { BundleStore } from './bundles.ts';
import type { Limits } from './limits.ts';
import {
  AppDatabases,
  applyMigrations,
  backupDatabase,
  MigrationError,
  resetDatabase,
  type Migration,
  type MigrationOutcome,
} from './sandbox/appdb.ts';
import { callFunction, type CallRequest, type CallResult } from './sandbox/call.ts';

// The work a runner does, as plain data in and out: the same jobs travel from the web
// process to the supervisor (HTTP over a Unix socket) and from the supervisor to a
// worker process (IPC).

export type Job =
  | { type: 'call'; request: CallRequest }
  /** Stores an app's server code, so that calls can name it by its hash. */
  | { type: 'install'; app: string; bundle: string }
  | { type: 'build'; files: unknown }
  /** `reset` empties the database first: for a draft's database only, never the published one. */
  | { type: 'migrate'; database: string; migrations: Migration[]; reset?: boolean }
  | { type: 'vendor' }
  /** Copies an app database next to it, once per day. */
  | { type: 'backup'; database: string; date: string; keep: number };

export type MigrateResult =
  ({ ok: true } & MigrationOutcome) | { ok: false; migration: string | null; message: string };

export interface JobResults {
  call: CallResult;
  install: { hash: string };
  build: BuildOutcome;
  migrate: MigrateResult;
  vendor: VendorFiles;
  backup: { ok: true; written: boolean } | { ok: false; message: string };
}

export type JobResult<J extends Job = Job> = JobResults[J['type']];

/**
 * Calls are short and go to workers that stay up. Everything else is rare, may be slow, and
 * reads what an agent wrote with large libraries (the bundler, the CSS compiler): each of
 * those jobs gets a process of its own, gone when the job is done, so that nothing a hostile
 * source did to it can outlive the job.
 */
export function isOneShot(job: Job): boolean {
  return job.type === 'build' || job.type === 'vendor' || job.type === 'migrate' || job.type === 'backup';
}

/** How long a job may run before the process doing it is killed. */
export function timeoutOf(job: Job, limits: Limits): number {
  switch (job.type) {
    case 'call':
    case 'install':
      return limits.callMs;
    case 'migrate':
      return limits.migrateMs;
    case 'backup':
      return limits.backupMs;
    default:
      return limits.buildMs;
  }
}

/** The app a database belongs to: "notes/live" → "notes". */
const appOf = (database: string): string => database.split('/')[0] ?? '';

export interface Executor {
  run<J extends Job>(job: J): Promise<JobResult<J>>;
  close(): void;
}

/** Runs jobs in this process. A worker process is one of these behind an IPC channel. */
export function createExecutor(appsDir: string, limits: Limits): Executor {
  const databases = new AppDatabases(appsDir, limits);
  const bundles = new BundleStore(appsDir);
  const run = async (job: Job): Promise<JobResult> => {
    switch (job.type) {
      case 'call': {
        const { bundleHash, ...request } = job.request;
        const bundle = bundles.load(appOf(request.database), bundleHash);
        if (bundle === null) {
          return {
            ok: false,
            error: { code: 'bundle_missing', message: 'the runner does not have this code' },
            logs: [],
          };
        }
        return callFunction(databases, { ...request, bundle }, limits);
      }
      case 'install':
        return { hash: bundles.install(job.app, job.bundle) };
      case 'build':
        return buildApp(job.files, limits);
      case 'vendor':
        return buildVendor();
      case 'backup':
        try {
          return { ok: true, written: backupDatabase(appsDir, job.database, job.date, job.keep) !== null };
        } catch (error) {
          return { ok: false, message: (error as Error).message };
        }
      case 'migrate': {
        let connection;
        try {
          if (job.reset && job.database.endsWith('/live')) {
            return { ok: false, migration: null, message: 'the published database is never emptied' };
          }
          connection = databases.migrator(job.database);
          if (job.reset) resetDatabase(connection);
          return { ok: true, ...applyMigrations(connection, job.migrations, limits) };
        } catch (error) {
          if (error instanceof MigrationError) return { ok: false, migration: error.migration, message: error.message };
          return { ok: false, migration: null, message: (error as Error).message };
        } finally {
          connection?.db.close();
        }
      }
    }
  };
  return {
    run: run as Executor['run'],
    close: () => databases.closeAll(),
  };
}
