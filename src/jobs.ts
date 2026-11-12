import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { purgeExpired } from './auth/sessions.ts';
import { run } from './db/database.ts';
import type { Deps } from './types.ts';

const KEEP_BACKUPS = 14;

/** Consistent snapshot of the platform database, one per day. */
export function backupDatabase(deps: Deps, date: string): string | null {
  const dir = path.join(deps.config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `socle-${date}.db`);
  if (existsSync(file)) return null;
  run(deps.db, 'VACUUM INTO :file', { file });
  const old = readdirSync(dir)
    .filter((name) => /^socle-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const name of old) rmSync(path.join(dir, name), { force: true });
  return file;
}

export function startJobs(deps: Deps): () => void {
  let lastBackup = '';
  const tick = () => {
    try {
      purgeExpired(deps.db);
      const now = deps.now().toISOString();
      const today = now.slice(0, 10);
      // 02:30 UTC: the middle of the night in France, summer and winter.
      if (today !== lastBackup && now.slice(11, 16) >= '02:30') {
        const file = backupDatabase(deps, today);
        if (file) console.info(`backup written: ${file}`);
        lastBackup = today;
      }
    } catch (error) {
      console.error('background job failed:', error);
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, 10 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
