import type { AppRow } from './apps/registry.ts';
import type { IdentityProvider } from './auth/google.ts';
import type { ActiveSession } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
import type { PushService } from './push/push.ts';

export interface Deps {
  config: Config;
  db: Db;
  identity: IdentityProvider;
  push: PushService;
  now: () => Date;
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
