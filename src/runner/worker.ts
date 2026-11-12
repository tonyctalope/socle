import { createExecutor } from './jobs.ts';
import type { Job } from './jobs.ts';
import type { Limits } from './limits.ts';

// A worker process: runs one job at a time for the supervisor, which kills it if a
// job outlives its deadline. Everything it needs comes on the command line; its
// environment is empty.

interface WorkerConfig {
  appsDir: string;
  limits: Limits;
}

const config = JSON.parse(process.argv[2] ?? 'null') as WorkerConfig | null;
if (!config || !process.send) {
  console.error('worker.ts is started by the runner, not by hand');
  process.exit(2);
}

const executor = createExecutor(config.appsDir, config.limits);

process.on('message', (message: { id: number; job: Job }) => {
  executor.run(message.job).then(
    (result) => process.send!({ id: message.id, result }),
    (error: unknown) => {
      console.error('job failed:', error);
      process.send!({ id: message.id, failure: 'the runner failed to do this' });
    },
  );
});

// The supervisor went away: nothing left to work for.
process.on('disconnect', () => process.exit(0));

process.send({ ready: true });
