import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Job, JobResult } from './jobs.ts';
import type { Limits } from './limits.ts';
import { PoolFailure, WorkerPool } from './pool.ts';

// The runner as a service: jobs arrive as JSON over a Unix socket (the only thing
// this process shares with the web process), and are handed to the worker pool.

const MAX_BODY = 12 * 1024 * 1024;

/** What travels back over the socket. */
export type Reply<J extends Job = Job> =
  | { ok: true; result: JobResult<J> }
  | { ok: false; failure: { code: PoolFailure['code'] | 'invalid'; message: string } };

const JOB_TYPES = new Set(['call', 'build', 'migrate', 'vendor', 'backup', 'warm']);

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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      // The socket is the runner's whole attack surface: only its own user may connect.
      chmodSync(options.socketPath, 0o600);
      resolve();
    });
  });
  void pool.run({ type: 'warm' }).catch(() => {});

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
