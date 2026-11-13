import type { CallGate } from './apphost/gate.ts';
import type { LiveHub } from './apphost/live.ts';
import type { VendorCache } from './apphost/vendor.ts';
import type { AppRow } from './apps/registry.ts';
import type { Site } from './apps/slug.ts';
import type { AppStore } from './apps/store.ts';
import type { IdentityProvider } from './auth/oidc.ts';
import type { ActiveSession } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
import type { FileStore } from './files/store.ts';
import type { PushService } from './push/push.ts';
import type { Runner } from './runner/client.ts';

export interface Deps {
  config: Config;
  db: Db;
  identity: IdentityProvider;
  push: PushService;
  /** Builds apps and runs their server functions, away from this process's secrets. */
  runner: Runner;
  apps: AppStore;
  /** The photos and documents members add to apps. */
  files: FileStore;
  live: LiveHub;
  /** Shares the runner's workers between apps (see apphost/gate.ts). Created by the app host when absent. */
  gate?: CallGate;
  vendor: Pick<VendorCache, 'get' | 'warm'>;
  now: () => Date;
  /** How often an open event stream is checked and kept alive (tests shorten it). */
  streamPingMs?: number;
}

/** Requests on the control-plane host. */
export interface ControlEnv {
  Variables: {
    session: ActiveSession | null;
  };
}

/** Requests on an app host (<slug>.<APPS_DOMAIN>). */
export interface AppHostEnv {
  Variables: {
    app: AppRow;
    /** Which of the app's two addresses this is: the published one or the draft's. */
    site: Site;
    session: ActiveSession | null;
  };
}

export function allowlist(config: Config): (email: string) => boolean {
  return (email) => config.allowedEmails.has(email.toLowerCase());
}

/** Admins publish apps and manage the instance; being removed from the allowlist ends that too. */
export function isAdmin(config: Config, user: { email: string }): boolean {
  const email = user.email.toLowerCase();
  return config.allowedEmails.has(email) && config.adminEmails.has(email);
}
