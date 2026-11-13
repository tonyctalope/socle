import { buildApp, type BuildOutcome } from './build/build.ts';
import { buildVendor, type VendorFiles } from './build/vendor.ts';
import { BundleStore, purgeRemoved, removeApp } from './bundles.ts';
import type { Limits } from './limits.ts';
import {
  AppDatabases,
  applyMigrations,
  backupDatabase,
  MigrationError,
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
  | { type: 'backup'; database: string; date: string; keep: number }
  /** Takes everything the runner keeps for an app (data, code, copies) out of service. */
  | { type: 'remove'; app: string };

export type MigrateResult =
  ({ ok: true } & MigrationOutcome) | { ok: false; migration: string | null; message: string };

export interface JobResults {
  call: CallResult;
  install: { hash: string };
  build: BuildOutcome;
  migrate: MigrateResult;
  vendor: VendorFiles;
  backup: { ok: true; written: boolean } | { ok: false; message: string };
  remove: { ok: true; removed: boolean } | { ok: false; message: string };
}

export type JobResult<J extends Job = Job> = JobResults[J['type']];

/**
 * Calls are short and go to workers that stay up. Everything else is rare, may be slow, and
 * reads what an agent wrote with large libraries (the bundler, the CSS compiler): each of
 * those jobs gets a process of its own, gone when the job is done, so that nothing a hostile
 * source did to it can outlive the job.
 */
export function isOneShot(job: Job): boolean {
  return (
    job.type === 'build' ||
    job.type === 'vendor' ||
    job.type === 'migrate' ||
    job.type === 'backup' ||
    job.type === 'remove'
  );
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
      case 'remove':
        try {
          return { ok: true, removed: removeApp(appsDir, job.app) };
        } catch (error) {
          return { ok: false, message: (error as Error).message };
        }
      case 'backup':
        try {
          purgeRemoved(appsDir);
          return { ok: true, written: backupDatabase(appsDir, job.database, job.date, job.keep) !== null };
        } catch (error) {
          return { ok: false, message: (error as Error).message };
        }
      case 'migrate': {
        let connection;
        try {
          // Only a draft's database is ever emptied: said by name, not by exclusion.
          if (job.reset && !job.database.endsWith('/draft')) {
            return { ok: false, migration: null, message: 'only a draft database can be emptied' };
          }
          connection = databases.migrator(job.database);
          return { ok: true, ...applyMigrations(connection, job.migrations, limits, { reset: job.reset === true }) };
        } catch (error) {
          if (error instanceof MigrationError) return { ok: false, migration: error.migration, message: error.message };
          // Not the app's doing (a full disk, a folder that cannot be written): the detail, paths
          // included, stays in the runner's log.
          console.error(`migration of ${job.database} failed:`, (error as Error).message);
          return { ok: false, migration: null, message: 'the database could not be opened or written' };
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
