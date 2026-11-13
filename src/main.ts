import { siteOf } from './apps/slug.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { LiveHub } from './apphost/live.ts';
import { VendorCache } from './apphost/vendor.ts';
import { syncDemoApp } from './apps/demo.ts';
import { AppStore } from './apps/store.ts';
import { createOidcProvider } from './auth/oidc.ts';
import { appOrigin, ConfigError, loadConfig, type Config } from './config.ts';
import { openDatabase } from './db/database.ts';
import { startJobs } from './jobs.ts';
import { createPushService } from './push/push.ts';
import { localRunner, remoteRunner } from './runner/client.ts';
import { DEFAULT_LIMITS } from './runner/limits.ts';
import type { Deps } from './types.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(path.join(config.dataDir, 'socle.db'));
// What agents write is built and run by the runner: another container in production,
// worker processes of this one in development.
const runner = config.runnerSocket
  ? remoteRunner(config.runnerSocket, DEFAULT_LIMITS)
  : localRunner({ appsDir: path.join(config.dataDir, 'apps'), limits: DEFAULT_LIMITS });
const apps = new AppStore(db, runner);
const live = new LiveHub();
// Open pages of an app reload when a new version of it is published.
apps.onPublish = (slug) => live.publish(slug, 'version');
apps.onDraft = (slug) => live.publish(siteOf(slug, true).label, 'version');
apps.onRemove = (slug) => {
  for (const draft of [false, true]) {
    // Open pages learn they must reload, then their streams end.
    live.publish(siteOf(slug, draft).label, 'version');
    live.close(siteOf(slug, draft).label);
  }
};
const deps: Deps = {
  config,
  db,
  identity: createOidcProvider(config),
  push: createPushService(db, config),
  runner,
  apps,
  live,
  vendor: new VendorCache(runner),
  now: () => new Date(),
};

/** Needs the runner, which may start after this process: keep trying, the rest of the platform works meanwhile. */
async function prepareApps(attempt = 1): Promise<void> {
  try {
    const outcome = await syncDemoApp(db, apps, config.demoApp, config.locale);
    if (outcome && !outcome.ok) {
      console.error(`demo app not published (${outcome.stage}):`, JSON.stringify(outcome.problems));
    } else if (outcome && !outcome.unchanged) {
      console.info(`demo app published (version ${outcome.versionId})`);
    }
    await deps.vendor.warm();
  } catch (error) {
    if (stopping) return;
    if (attempt === 1 || attempt % 12 === 0) console.warn(`runner not ready (${(error as Error).message}), retrying`);
    setTimeout(() => void prepareApps(attempt + 1), 5_000).unref();
  }
}

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.info(
    `socle listening on ${info.address}:${info.port} — control ${config.controlOrigin}, apps ${appOrigin(config, '<app>')} (${config.allowedEmails.size} allowed account(s))`,
  );
});
const stopJobs = startJobs(deps);
let stopping = false;
void prepareApps();

const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.info(`${signal} received, shutting down`);
  stopJobs();
  live.closeAll();
  server.close(() => {
    db.close();
    void runner.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
