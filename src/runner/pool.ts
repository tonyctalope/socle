import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timeoutOf, type Job, type JobResult } from './jobs.ts';
import type { Limits } from './limits.ts';

// A few worker processes, each doing one job at a time. This is where time limits
// become guarantees: the interpreter stops a looping function by itself, but only
// between two instructions, and it cannot interrupt a SQL statement or a slow
// built-in at all. A job that outlives its deadline gets its worker killed; an
// unfinished transaction is rolled back by SQLite the next time the file is opened.

export class PoolFailure extends Error {
  readonly code: 'timeout' | 'crashed' | 'busy' | 'closed';
  constructor(code: PoolFailure['code'], message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  job: Job;
  resolve: (result: JobResult) => void;
  reject: (error: PoolFailure) => void;
}

interface Worker {
  child: ChildProcess;
  ready: boolean;
  current: (Pending & { id: number; timer: NodeJS.Timeout }) | null;
  dead: boolean;
}

export interface PoolOptions {
  appsDir: string;
  limits: Limits;
  /** Worker processes (default 2). */
  size?: number;
  /** Jobs allowed to wait for a free worker before new ones are refused (default 200). */
  maxQueue?: number;
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

export class WorkerPool {
  private readonly options: Required<PoolOptions>;
  private readonly workers: Worker[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  /** Workers killed because a job outlived its deadline (for tests and /health). */
  killed = 0;

  constructor(options: PoolOptions) {
    this.options = { ...options, size: options.size ?? 2, maxQueue: options.maxQueue ?? 200 };
  }

  run<J extends Job>(job: J): Promise<JobResult<J>> {
    if (this.closed) return Promise.reject(new PoolFailure('closed', 'the runner is shutting down'));
    return new Promise<JobResult>((resolve, reject) => {
      if (this.queue.length >= this.options.maxQueue) {
        reject(new PoolFailure('busy', 'the runner is overloaded, try again in a moment'));
        return;
      }
      this.queue.push({ job, resolve, reject });
      this.dispatch();
    }) as Promise<JobResult<J>>;
  }

  /** Workers currently alive, and jobs waiting. */
  stats(): { workers: number; busy: number; queued: number; killed: number } {
    return {
      workers: this.workers.length,
      busy: this.workers.filter((worker) => worker.current).length,
      queued: this.queue.length,
      killed: this.killed,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0))
      pending.reject(new PoolFailure('closed', 'the runner is shutting down'));
    await Promise.all(
      this.workers.splice(0).map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.dead = true;
            if (worker.current) {
              clearTimeout(worker.current.timer);
              worker.current.reject(new PoolFailure('closed', 'the runner is shutting down'));
              worker.current = null;
            }
            if (worker.child.exitCode !== null || worker.child.signalCode !== null) return resolve();
            worker.child.once('exit', () => resolve());
            worker.child.kill('SIGKILL');
          }),
      ),
    );
  }

  private spawn(): Worker {
    const child = fork(WORKER, [JSON.stringify({ appsDir: this.options.appsDir, limits: this.options.limits })], {
      // Nothing of the supervisor's environment reaches the code that handles app content.
      env: { NODE_ENV: 'production' },
      execArgv: ['--max-old-space-size=384'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker: Worker = { child, ready: false, current: null, dead: false };
    child.on('message', (message: { ready?: boolean; id?: number; result?: JobResult; failure?: string }) => {
      if (message.ready) {
        worker.ready = true;
        this.dispatch();
        return;
      }
      const current = worker.current;
      if (!current || message.id !== current.id) return;
      clearTimeout(current.timer);
      worker.current = null;
      if (message.failure !== undefined) current.reject(new PoolFailure('crashed', message.failure));
      else current.resolve(message.result as JobResult);
      this.dispatch();
    });
    child.on('exit', () => this.retire(worker, new PoolFailure('crashed', 'the runner stopped while doing this')));
    child.on('error', () => this.retire(worker, new PoolFailure('crashed', 'the runner could not start a worker')));
    this.workers.push(worker);
    return worker;
  }

  private retire(worker: Worker, reason: PoolFailure): void {
    if (worker.dead) return;
    worker.dead = true;
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    if (worker.current) {
      clearTimeout(worker.current.timer);
      worker.current.reject(reason);
      worker.current = null;
    }
    if (!this.closed) this.dispatch();
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let worker = this.workers.find((candidate) => candidate.ready && !candidate.current && !candidate.dead);
      if (!worker) {
        // Start another one if allowed; the job waits for its "ready".
        const starting = this.workers.some((candidate) => !candidate.ready);
        if (!starting && this.workers.length < this.options.size) worker = this.spawn();
        return;
      }
      const pending = this.queue.shift()!;
      const id = this.nextId++;
      const { limits } = this.options;
      const active = worker;
      const timer = setTimeout(
        () => {
          this.killed += 1;
          active.child.kill('SIGKILL');
          this.retire(active, new PoolFailure('timeout', 'this took too long and was stopped'));
        },
        timeoutOf(pending.job, limits) + limits.killGraceMs,
      );
      active.current = { ...pending, id, timer };
      active.child.send({ id, job: pending.job }, (error) => {
        if (error) this.retire(active, new PoolFailure('crashed', 'the runner lost a worker'));
      });
    }
  }
}
