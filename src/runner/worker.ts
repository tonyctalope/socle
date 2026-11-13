import { writeFileSync } from 'node:fs';
import { stop } from 'esbuild';
import { createExecutor } from './jobs.ts';
import type { Job } from './jobs.ts';
import type { Limits } from './limits.ts';
import { guestPrelude } from './sandbox/engine.ts';

// A worker process: runs one job at a time for the supervisor, which kills it if a
// job outlives its deadline. Everything it needs comes on the command line; its
// environment is empty.

interface WorkerConfig {
  appsDir: string;
  limits: Limits;
  /** Do one job, then exit (builds, migrations, backups). */
  once: boolean;
}

const config = JSON.parse(process.argv[2] ?? 'null') as WorkerConfig | null;
if (!config || !process.send) {
  console.error('worker.ts is started by the runner, not by hand');
  process.exit(2);
}

// If the machine runs out of memory, this process should go before the supervisor does.
try {
  writeFileSync('/proc/self/oom_score_adj', '1000');
} catch {
  // not Linux, or not allowed: nothing depends on it
}

const executor = createExecutor(config.appsDir, config.limits);

if (!config.once) {
  // A worker that serves calls only needs the bundler once, for the platform's own library:
  // build it now and let the bundler go.
  await guestPrelude();
  await stop();
}

/** Something is broken in this process (a bundler that died, for instance): answer, then leave, so that the next job gets a healthy one. */
function giveUp(id: number, error: unknown): void {
  console.error('job failed:', error);
  process.send!({ id, failure: 'the runner failed to do this' }, () => process.exit(1));
}

process.on('message', (message: { id: number; job: Job }) => {
  executor.run(message.job).then(
    (result) => {
      try {
        process.send!({ id: message.id, result }, () => {
          if (config.once) process.exit(0);
        });
      } catch (error) {
        // A result that cannot be put on the wire.
        giveUp(message.id, error);
      }
    },
    giveUp.bind(null, message.id),
  );
});

// The supervisor went away: nothing left to work for.
process.on('disconnect', () => process.exit(0));

process.send({ ready: true });
