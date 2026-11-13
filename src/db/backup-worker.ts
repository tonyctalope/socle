import { DatabaseSync } from 'node:sqlite';
import { workerData } from 'node:worker_threads';

// Copies a database file to `target`, in a thread of its own: the copy reads the whole
// file, and the thread that answers requests must not wait for it.

const { source, target } = workerData as { source: string; target: string };
const db = new DatabaseSync(source, { readOnly: true, timeout: 10_000 });
try {
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}
