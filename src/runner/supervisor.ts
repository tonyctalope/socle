import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Job, JobResult } from './jobs.ts';
import type { Limits } from './limits.ts';
import { PoolFailure, WorkerPool } from './pool.ts';

// The runner as a service: jobs arrive as JSON over a Unix socket (the only thing
// this process shares with the web process), and are handed to the worker pool.

/** A build carries an app's sources, an install its server code; calls are far smaller. */
const MAX_BODY = 8 * 1024 * 1024;
/** Requests being received or answered at once; more are turned away at the door. */
const MAX_REQUESTS = 48;

/** What travels back over the socket. */
export type Reply<J extends Job = Job> =
  | { ok: true; result: JobResult<J> }
  | { ok: false; failure: { code: PoolFailure['code'] | 'invalid'; message: string } };

const JOB_TYPES = new Set(['call', 'install', 'build', 'migrate', 'vendor', 'backup']);

export async function answer(pool: WorkerPool, job: unknown): Promise<Reply> {
  if (typeof job !== 'object' || job === null || !JOB_TYPES.has((job as { type?: string }).type ?? '')) {
    return { ok: false, failure: { code: 'invalid', message: 'unknown job' } };
  }
  try {
    return { ok: true, result: await pool.run(job as Job) };
  } catch (error) {
    if (error instanceof PoolFailure) return { ok: false, failure: { code: error.code, message: error.message } };
    throw error;
  }
}

export interface RunnerService {
  pool: WorkerPool;
  close(): Promise<void>;
}

export interface RunnerOptions {
  socketPath: string;
  appsDir: string;
  limits: Limits;
  workers?: number;
}

export async function startRunner(options: RunnerOptions): Promise<RunnerService> {
  mkdirSync(options.appsDir, { recursive: true });
  mkdirSync(path.dirname(options.socketPath), { recursive: true });
  rmSync(options.socketPath, { force: true }); // left over from a previous run
  const pool = new WorkerPool({ appsDir: options.appsDir, limits: options.limits, size: options.workers });

  let active = 0;
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { ok: true, ...pool.stats() });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/job') {
      send(404, { ok: false });
      return;
    }
    if (active >= MAX_REQUESTS) {
      send(503, { ok: false, failure: { code: 'busy', message: 'the runner is overloaded, try again in a moment' } });
      request.resume();
      return;
    }
    active += 1;
    response.once('close', () => {
      active -= 1;
    });
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(413, { ok: false, failure: { code: 'invalid', message: 'job too large' } });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      let job: unknown;
      try {
        job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(400, { ok: false, failure: { code: 'invalid', message: 'not JSON' } });
        return;
      }
      answer(pool, job).then(
        (reply) => send(200, reply),
        (error: unknown) => {
          console.error('runner error:', error);
          send(500, { ok: false, failure: { code: 'crashed', message: 'the runner failed' } });
        },
      );
    });
  });

  // The socket is the runner's whole attack surface: only its own user may connect, from
  // the moment it exists.
  const umask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        chmodSync(options.socketPath, 0o600);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  pool.warm();

  return {
    pool,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await pool.close();
      rmSync(options.socketPath, { force: true });
    },
  };
}
