import type { CallGate } from './apphost/gate.ts';
import type { LiveHub } from './apphost/live.ts';
import type { VendorCache } from './apphost/vendor.ts';
import type { AppRow } from './apps/registry.ts';
import type { AppStore } from './apps/store.ts';
import type { IdentityProvider } from './auth/oidc.ts';
import type { ActiveSession } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
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
    session: ActiveSession | null;
  };
}

export function allowlist(config: Config): (email: string) => boolean {
  return (email) => config.allowedEmails.has(email.toLowerCase());
}
