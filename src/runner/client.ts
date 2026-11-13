import { request } from 'node:http';
import type { BuildOutcome } from './build/build.ts';
import type { VendorFiles } from './build/vendor.ts';
import type { Job, JobResult, MigrateResult } from './jobs.ts';
import type { Limits } from './limits.ts';
import { WorkerPool } from './pool.ts';
import type { Migration } from './sandbox/appdb.ts';
import type { CallRequest, CallResult } from './sandbox/call.ts';
import { answer, type Reply } from './supervisor.ts';

// How the web process talks to the runner. In production the runner is another
// container without network or secrets, reached over a Unix socket; in development
// and in tests the same worker pool is started in-process.

/** The runner could not do the job at all (as opposed to the job failing). */
export class RunnerUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Runner {
  build(files: unknown): Promise<BuildOutcome>;
  vendor(): Promise<VendorFiles>;
  /** `reset` empties the database first (a draft's database only). */
  migrate(database: string, migrations: Migration[], options?: { reset?: boolean }): Promise<MigrateResult>;
  /** Stores an app's server code in the runner and returns the hash that calls name it by. */
  install(app: string, bundle: string): Promise<string>;
  call(request: CallRequest): Promise<CallResult>;
  /** Copies an app database next to it (one copy per day, the last `keep` are kept). */
  backup(database: string, date: string, keep: number): Promise<JobResult<{ type: 'backup' } & Job>>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

type Send = <J extends Job>(job: J) => Promise<Reply<J>>;

/** Ways the runner can fail a call that are the call's own outcome, not the runner being away. */
const CALL_FAILURES: Record<string, string | undefined> = {
  timeout: 'the function ran for too long and was stopped',
  memory: 'the function used too much memory and was stopped',
  busy: 'the platform is busy, try again in a moment',
  crashed: 'the function crashed the sandbox',
};

/** The largest answer the runner sends: a built app (screens, stylesheet, server code). */
const MAX_REPLY = 24 * 1024 * 1024;

function runner(send: Send, healthy: () => Promise<boolean>, close: () => Promise<void>): Runner {
  const run = async <J extends Job>(job: J): Promise<JobResult<J>> => {
    const reply = await send(job);
    if (reply.ok) return reply.result;
    throw new RunnerUnavailable(reply.failure.code, reply.failure.message);
  };
  return {
    build: (files) => run({ type: 'build', files }),
    vendor: () => run({ type: 'vendor' }),
    migrate: (database, migrations, options) =>
      run({ type: 'migrate', database, migrations, ...(options?.reset ? { reset: true } : {}) }),
    install: async (app, bundle) => (await run({ type: 'install', app, bundle })).hash,
    backup: (database, date, keep) => run({ type: 'backup', database, date, keep }),
    async call(callRequest) {
      try {
        return await run({ type: 'call', request: callRequest });
      } catch (error) {
        // A killed or overloaded worker is, for the caller, one more way a function can fail.
        if (!(error instanceof RunnerUnavailable)) throw error;
        const message = Object.hasOwn(CALL_FAILURES, error.code) ? CALL_FAILURES[error.code] : undefined;
        if (message === undefined) throw error;
        return { ok: false, error: { code: error.code, message }, logs: [] };
      }
    },
    healthy,
    close,
  };
}

/** A runner living in this process's own worker pool (development, tests). */
export function localRunner(options: { appsDir: string; limits: Limits; workers?: number }): Runner {
  const pool = new WorkerPool({ appsDir: options.appsDir, limits: options.limits, size: options.workers });
  return runner(
    (job) => answer(pool, job) as Promise<Reply<typeof job>>,
    () => Promise.resolve(true),
    () => pool.close(),
  );
}

function post<T>(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers:
          text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY) {
            outgoing.destroy(new RunnerUnavailable('crashed', 'the runner sent an answer that is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new RunnerUnavailable('crashed', 'the runner sent an unreadable answer'));
          }
        });
        response.on('error', () => reject(new RunnerUnavailable('crashed', 'the connection to the runner broke')));
      },
    );
    outgoing.on('timeout', () =>
      outgoing.destroy(new RunnerUnavailable('timeout', 'the runner did not answer in time')),
    );
    outgoing.on('error', (error) =>
      reject(
        error instanceof RunnerUnavailable
          ? error
          : new RunnerUnavailable('unreachable', 'the runner is not reachable'),
      ),
    );
    outgoing.end(text);
  });
}

/** The runner of the deployment, behind its Unix socket. */
export function remoteRunner(socketPath: string, limits: Limits): Runner {
  // The runner enforces the real deadlines; this one only covers a runner that is gone.
  // One-shot jobs (builds, migrations, backups) also wait for their turn in the runner.
  const patience = 4 * Math.max(limits.buildMs, limits.migrateMs, limits.backupMs) + limits.killGraceMs + 5_000;
  return runner(
    (job) => post(socketPath, 'POST', '/job', job, patience),
    () =>
      post<{ ok?: boolean }>(socketPath, 'GET', '/health', undefined, 2_000).then(
        (reply) => reply.ok === true,
        () => false,
      ),
    () => Promise.resolve(),
  );
}
