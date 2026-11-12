import { buildApp, type BuildOutcome } from './build/build.ts';
import { buildVendor, type VendorFiles } from './build/vendor.ts';
import type { Limits } from './limits.ts';
import {
  AppDatabases,
  applyMigrations,
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
  | { type: 'build'; files: unknown }
  | { type: 'migrate'; database: string; migrations: Migration[] }
  | { type: 'vendor' }
  /** Loads the interpreter and the bundler, so the first real job is not the slow one. */
  | { type: 'warm' };

export type MigrateResult =
  ({ ok: true } & MigrationOutcome) | { ok: false; migration: string | null; message: string };

export interface JobResults {
  call: CallResult;
  build: BuildOutcome;
  migrate: MigrateResult;
  vendor: VendorFiles;
  warm: { ok: true };
}

export type JobResult<J extends Job = Job> = JobResults[J['type']];

/** How long a job may run before the worker doing it is killed. */
export function timeoutOf(job: Job, limits: Limits): number {
  switch (job.type) {
    case 'call':
      return limits.callMs;
    case 'migrate':
      return limits.migrateMs;
    default:
      return limits.buildMs;
  }
}

export interface Executor {
  run<J extends Job>(job: J): Promise<JobResult<J>>;
  close(): void;
}

/** Runs jobs in this process. A worker process is one of these behind an IPC channel. */
export function createExecutor(appsDir: string, limits: Limits): Executor {
  const databases = new AppDatabases(appsDir, limits);
  const run = async (job: Job): Promise<JobResult> => {
    switch (job.type) {
      case 'call':
        return callFunction(databases, job.request, limits);
      case 'build':
        return buildApp(job.files, limits);
      case 'vendor':
        return buildVendor();
      case 'warm':
        await buildApp({ 'app.json': '{"name":"warm"}', 'web/main.tsx': 'export default () => null;' }, limits);
        return { ok: true };
      case 'migrate': {
        let connection;
        try {
          connection = databases.migrator(job.database);
          return { ok: true, ...applyMigrations(connection, job.migrations) };
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
