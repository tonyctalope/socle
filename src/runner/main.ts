import path from 'node:path';
import { DEFAULT_LIMITS } from './limits.ts';
import { startRunner } from './supervisor.ts';

// Entry point of the runner container: `node src/runner/main.ts`. It needs two
// things from its environment and nothing else: where the socket goes, and where
// the apps' databases live. No secret, no network.

const socketPath = process.env.RUNNER_SOCKET;
const appsDir = process.env.APPS_DIR;
if (!socketPath || !appsDir) {
  console.error('Configuration error: RUNNER_SOCKET and APPS_DIR are required');
  process.exit(1);
}
const workers = Number(process.env.RUNNER_WORKERS ?? 3);
if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
  console.error('Configuration error: RUNNER_WORKERS must be a number from 1 to 16');
  process.exit(1);
}

const service = await startRunner({
  socketPath: path.resolve(socketPath),
  appsDir: path.resolve(appsDir),
  limits: DEFAULT_LIMITS,
  workers,
});
console.info(`socle runner listening on ${socketPath} — apps in ${appsDir}, ${workers} worker(s)`);

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.info(`${signal} received, shutting down`);
  void service.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
