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

/**
 * Each published app's own data, copied by the runner (the only process that opens those
 * files). One app's copy failing, for whatever reason, never stops the others: `failed` lists
 * the apps to try again.
 */
export async function backupApps(deps: Deps, date: string): Promise<{ written: number; failed: string[] }> {
  let written = 0;
  const failed: string[] = [];
  for (const app of listApps(deps.db)) {
    if (app.live_version === null) continue;
    try {
      const result = await deps.runner.backup(liveDatabase(app.slug), date, KEEP_BACKUPS);
      if (result.ok) {
        if (result.written) written += 1;
        continue;
      }
      console.error(`backup of ${app.slug} failed: ${result.message}`);
    } catch (error) {
      // Too slow and stopped, or the runner is away.
      console.error(`backup of ${app.slug} failed: ${(error as Error).message}`);
    }
    failed.push(app.slug);
  }
  return { written, failed };
}

/** How many times in a day the apps' backups are attempted before waiting for the next day. */
const BACKUP_ATTEMPTS = 3;

export function startJobs(deps: Deps): () => void {
  let lastBackup = '';
  let appBackups = { day: '', attempts: 0, running: false };
  const tick = () => {
    try {
      purgeExpired(deps.db);
      const now = deps.now().toISOString();
      const today = now.slice(0, 10);
      // 02:30 UTC: the middle of the night in France, summer and winter.
      if (now.slice(11, 16) < '02:30') return;
      if (today !== lastBackup) {
        const file = backupDatabase(deps, today);
        if (file) console.info(`backup written: ${file}`);
        lastBackup = today;
      }
      if (appBackups.day !== today) appBackups = { day: today, attempts: 0, running: false };
      if (appBackups.running || appBackups.attempts >= BACKUP_ATTEMPTS) return;
      const round = appBackups;
      round.running = true;
      round.attempts += 1;
      void backupApps(deps, today)
        .then(({ written, failed }) => {
          if (written) console.info(`app backups written: ${written}`);
          // Everything copied: no further attempt today. Otherwise the next tick tries again.
          if (failed.length === 0) round.attempts = BACKUP_ATTEMPTS;
        })
        .catch((error: unknown) => console.error('app backups failed:', (error as Error).message))
        .finally(() => {
          round.running = false;
        });
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
