import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listApps } from './apps/registry.ts';
import { liveDatabase } from './apps/store.ts';
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

/** Each published app's own data, copied by the runner (the only process that opens those files). */
export async function backupApps(deps: Deps, date: string): Promise<number> {
  let written = 0;
  for (const app of listApps(deps.db)) {
    if (app.live_version === null) continue;
    const result = await deps.runner.backup(liveDatabase(app.slug), date, KEEP_BACKUPS);
    if (!result.ok) console.error(`backup of ${app.slug} failed: ${result.message}`);
    else if (result.written) written += 1;
  }
  return written;
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
        backupApps(deps, today).then(
          (count) => count && console.info(`app backups written: ${count}`),
          // The runner was away: the platform's own backup is done, the apps' will be retried tomorrow.
          (error: unknown) => console.error('app backups failed:', (error as Error).message),
        );
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
