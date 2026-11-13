import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { listApps } from './apps/registry.ts';
import { runSchedules } from './apps/scheduler.ts';
import { liveDatabase } from './apps/store.ts';
import { purgeExpired } from './auth/sessions.ts';
import { purgeClients } from './oauth/clients.ts';
import { purgeOAuth } from './oauth/tokens.ts';
import type { Deps } from './types.ts';

const KEEP_BACKUPS = 14;

/** A copy that is still running after this long is stopped: the next night starts a new one. */
const COPY_DEADLINE_MS = 10 * 60_000;
let copying = false;

/**
 * Consistent snapshot of a database file, one per day, written by a thread of its own so
 * that requests are answered meanwhile. Null when today's copy already exists, or when a
 * copy is still running. One copy at a time, stopped at a deadline: a copy that hangs does
 * not leave one more thread behind every night.
 */
export async function backupDatabase(
  dataDir: string,
  date: string,
  deadlineMs = COPY_DEADLINE_MS,
): Promise<string | null> {
  const dir = path.join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `socle-${date}.db`);
  if (existsSync(file) || copying) return null;
  copying = true;
  try {
    // Written under another name first: a copy cut short never looks like a backup. What
    // earlier copies left half-written is swept here (only one copy runs at a time).
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.partial')) rmSync(path.join(dir, entry), { force: true });
    }
    const partial = `${file}.partial`;
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./db/backup-worker.ts', import.meta.url), {
        workerData: { source: path.join(dataDir, 'socle.db'), target: partial },
      });
      const deadline = setTimeout(() => {
        void worker.terminate();
        reject(new Error('the copy took too long and was stopped'));
      }, deadlineMs);
      deadline.unref();
      worker.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`backup thread exited with ${code}`));
      });
    });
    renameSync(partial, file);
    const old = readdirSync(dir)
      .filter((name) => /^socle-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .sort()
      .slice(0, -KEEP_BACKUPS);
    for (const name of old) rmSync(path.join(dir, name), { force: true });
    return file;
  } finally {
    copying = false;
  }
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
      purgeOAuth(deps.db);
      purgeClients(deps.db);
      const now = deps.now().toISOString();
      const today = now.slice(0, 10);
      // Once a day, from 02:30 UTC on.
      if (now.slice(11, 16) < '02:30') return;
      if (today !== lastBackup) {
        lastBackup = today;
        void backupDatabase(deps.config.dataDir, today)
          .then((file) => file && console.info(`backup written: ${file}`))
          .catch((error: unknown) => {
            console.error('backup failed:', (error as Error).message);
            lastBackup = ''; // the next tick tries again
          });
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
  // Scheduled functions of the apps: looked at every minute, one round at a time.
  let scheduling = false;
  const schedules = setInterval(() => {
    if (scheduling) return;
    scheduling = true;
    void runSchedules(deps)
      .catch((error: unknown) => console.error('scheduled functions failed:', (error as Error).message))
      .finally(() => {
        scheduling = false;
      });
  }, 60_000);
  schedules.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(schedules);
  };
}
