import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isOneShot, timeoutOf, type Job, type JobResult } from './jobs.ts';
import type { Limits } from './limits.ts';

// Worker processes, each doing one job at a time. This is where time limits become
// guarantees: the interpreter stops a looping function by itself, but only between
// two instructions, and it cannot interrupt a SQL statement or a slow built-in at
// all. A job that outlives its deadline gets its process killed; an unfinished
// transaction is rolled back by SQLite the next time the file is opened.
//
// Two kinds of processes. Calls go to a few workers that stay up. Builds, migrations
// and backups each get a process of their own, one at a time, gone afterwards.

export class PoolFailure extends Error {
  readonly code: 'timeout' | 'memory' | 'crashed' | 'busy' | 'closed';
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
  once: boolean;
  ready: boolean;
  current: (Pending & { id: number; timer: NodeJS.Timeout }) | null;
  dead: boolean;
}

export interface PoolOptions {
  appsDir: string;
  limits: Limits;
  /** Worker processes serving calls (default 3). */
  size?: number;
  /** Calls allowed to wait for a free worker before new ones are refused (default 64). */
  maxQueue?: number;
  /** Builds, migrations and backups allowed to wait for their turn (default 16). */
  maxOneShotQueue?: number;
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
/** How often the memory of working processes is looked at. */
const WATCH_MS = 100;

/** Resident memory of a process in bytes, or 0 where it cannot be read (not Linux, process gone). */
function residentMemory(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const found = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return found ? Number(found[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
/** How long a process may take to start before it is given up on. */
const START_MS = 20_000;

export class WorkerPool {
  private readonly options: Required<PoolOptions>;
  private readonly workers: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly oneShotQueue: Pending[] = [];
  private oneShot: Worker | null = null;
  private nextId = 1;
  private closed = false;
  /** Processes killed because a job outlived its deadline or its memory (for tests and /health). */
  killed = 0;
  private watch: NodeJS.Timeout | undefined;

  constructor(options: PoolOptions) {
    this.options = {
      ...options,
      size: options.size ?? 3,
      maxQueue: options.maxQueue ?? 64,
      maxOneShotQueue: options.maxOneShotQueue ?? 16,
    };
  }

  run<J extends Job>(job: J): Promise<JobResult<J>> {
    if (this.closed) return Promise.reject(new PoolFailure('closed', 'the runner is shutting down'));
    return new Promise<JobResult>((resolve, reject) => {
      const once = isOneShot(job);
      const queue = once ? this.oneShotQueue : this.queue;
      if (queue.length >= (once ? this.options.maxOneShotQueue : this.options.maxQueue)) {
        reject(new PoolFailure('busy', 'the runner is overloaded, try again in a moment'));
        return;
      }
      queue.push({ job, resolve, reject });
      if (once) this.dispatchOneShot();
      else this.dispatch();
    }) as Promise<JobResult<J>>;
  }

  /** Call workers currently alive, and jobs waiting. */
  stats(): { workers: number; busy: number; queued: number; killed: number } {
    return {
      workers: this.workers.length,
      busy: this.workers.filter((worker) => worker.current).length,
      queued: this.queue.length + this.oneShotQueue.length,
      killed: this.killed,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.watch);
    this.watch = undefined;
    const gone = new PoolFailure('closed', 'the runner is shutting down');
    for (const pending of [...this.queue.splice(0), ...this.oneShotQueue.splice(0)]) pending.reject(gone);
    const all = [...this.workers.splice(0), ...(this.oneShot ? [this.oneShot] : [])];
    this.oneShot = null;
    await Promise.all(
      all.map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.dead = true;
            if (worker.current) {
              clearTimeout(worker.current.timer);
              worker.current.reject(gone);
              worker.current = null;
            }
            if (worker.child.exitCode !== null || worker.child.signalCode !== null) return resolve();
            worker.child.once('exit', () => resolve());
            worker.child.kill('SIGKILL');
          }),
      ),
    );
  }

  private spawn(once: boolean): Worker {
    const config = { appsDir: this.options.appsDir, limits: this.options.limits, once };
    const child = fork(WORKER, [JSON.stringify(config)], {
      // Nothing of the supervisor's environment reaches the code that handles app content.
      env: { NODE_ENV: 'production' },
      // --expose-gc: a call's memory is handed back as soon as the call is over (see engine.ts).
      execArgv: ['--max-old-space-size=384', '--expose-gc'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker: Worker = { child, once, ready: false, current: null, dead: false };
    const starting = setTimeout(() => {
      if (worker.ready || worker.dead) return;
      child.kill('SIGKILL');
      this.retire(worker, new PoolFailure('crashed', 'the runner could not start a worker'));
    }, START_MS);
    child.on('message', (message: { ready?: boolean; id?: number; result?: JobResult; failure?: string }) => {
      if (message.ready) {
        clearTimeout(starting);
        worker.ready = true;
        this.assign(worker);
        return;
      }
      const current = worker.current;
      if (!current || message.id !== current.id) return;
      clearTimeout(current.timer);
      worker.current = null;
      if (message.failure !== undefined) current.reject(new PoolFailure('crashed', message.failure));
      else current.resolve(message.result as JobResult);
      if (once) {
        // Its one job is done: the process goes, whether or not it was about to leave by itself.
        child.kill('SIGKILL');
        this.retire(worker, new PoolFailure('crashed', 'the runner stopped while doing this'));
      } else {
        this.dispatch();
      }
    });
    const gone = (reason: string) => {
      clearTimeout(starting);
      this.retire(worker, new PoolFailure('crashed', reason));
    };
    child.on('exit', () => gone('the runner stopped while doing this'));
    child.on('error', () => gone('the runner could not start a worker'));
    return worker;
  }

  /** Takes a process out of service; whatever it was doing fails with `reason`. */
  private retire(worker: Worker, reason: PoolFailure): void {
    if (worker.dead) return;
    worker.dead = true;
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    if (this.oneShot === worker) this.oneShot = null;
    if (worker.current) {
      clearTimeout(worker.current.timer);
      worker.current.reject(reason);
      worker.current = null;
    } else if (!worker.ready) {
      // It never got as far as taking a job: fail the one that was waiting for it, so that a
      // process that cannot start does not become an endless retry.
      (worker.once ? this.oneShotQueue : this.queue).shift()?.reject(reason);
    }
    if (this.closed) return;
    if (worker.once) this.dispatchOneShot();
    else this.dispatch();
  }

  /** Starts a first call worker ahead of the first call. */
  warm(): void {
    if (!this.closed && this.workers.length === 0) this.workers.push(this.spawn(false));
  }

  /** Hands a job to a process that is ready for one. */
  private start(worker: Worker, pending: Pending): void {
    const id = this.nextId++;
    const { limits } = this.options;
    const timer = setTimeout(
      () => {
        this.killed += 1;
        worker.child.kill('SIGKILL');
        this.retire(worker, new PoolFailure('timeout', 'this took too long and was stopped'));
      },
      timeoutOf(pending.job, limits) + limits.killGraceMs,
    );
    worker.current = { ...pending, id, timer };
    this.watchMemory();
    try {
      worker.child.send({ id, job: pending.job }, (error) => {
        if (error) this.retire(worker, new PoolFailure('crashed', 'the runner lost a worker'));
      });
    } catch {
      // The job could not even be put on the wire. The worker did nothing wrong and stays;
      // only this job fails. (This runs inside event handlers: nothing may be thrown from here.)
      clearTimeout(timer);
      worker.current = null;
      pending.reject(new PoolFailure('crashed', 'this job could not be sent to a worker'));
      if (worker.once) {
        worker.child.kill('SIGKILL');
        this.retire(worker, new PoolFailure('crashed', 'the runner stopped while doing this'));
      }
    }
  }

  /**
   * Time is bounded by a timer per job; memory by looking at each working process a few times a
   * second and killing the one that grew past its allowance. The sandbox bounds what the app's
   * JavaScript holds; this bounds everything else a job makes its process hold (SQLite's own
   * memory, above all), which nothing inside the process can.
   */
  private watchMemory(): void {
    if (this.watch) return;
    this.watch = setInterval(() => {
      const working = [...this.workers, ...(this.oneShot ? [this.oneShot] : [])].filter((worker) => worker.current);
      if (working.length === 0) {
        clearInterval(this.watch);
        this.watch = undefined;
        return;
      }
      for (const worker of working) {
        if (residentMemory(worker.child.pid) <= this.options.limits.workerMemory) continue;
        this.killed += 1;
        worker.child.kill('SIGKILL');
        this.retire(worker, new PoolFailure('memory', 'this used too much memory and was stopped'));
      }
    }, WATCH_MS);
    this.watch.unref();
  }

  private assign(worker: Worker): void {
    if (worker.once) {
      const pending = this.oneShotQueue.shift();
      // Nobody is waiting any more (the pool is closing): let the process go.
      if (pending) this.start(worker, pending);
      else worker.child.kill('SIGKILL');
    } else {
      this.dispatch();
    }
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const worker = this.workers.find((candidate) => candidate.ready && !candidate.current && !candidate.dead);
      if (!worker) {
        // Start another one if allowed; the job waits for its "ready".
        const starting = this.workers.some((candidate) => !candidate.ready);
        if (!starting && this.workers.length < this.options.size) this.workers.push(this.spawn(false));
        return;
      }
      this.start(worker, this.queue.shift()!);
    }
  }

  /** One process per job, one job at a time: the next starts when the previous process is gone. */
  private dispatchOneShot(): void {
    if (this.oneShot || this.oneShotQueue.length === 0 || this.closed) return;
    this.oneShot = this.spawn(true);
  }
}
