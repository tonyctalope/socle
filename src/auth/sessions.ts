import { get, run, type Db } from '../db/database.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import type { UserRow } from './users.ts';

/** Session cookie of the control plane. */
export const CONTROL_COOKIE = 'socle_session';
/** Session cookie of an app host. Same name on every app: cookies are host-only, so they never mix. */
export const APP_COOKIE = 'socle_app';
/**
 * Names this browser on the control plane and outlives its sessions. It is not a
 * credential: it only groups the sessions of one browser (their `family`), so that
 * signing out, or signing in as someone else, reaches every app host.
 */
export const DEVICE_COOKIE = 'socle_device';
export const DEVICE_TTL_SEC = 400 * 24 * 3600;
/** Scope of control-plane sessions; app sessions use the app's slug. */
export const CONTROL_SCOPE = '';

/** A session ends after this long without use… */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** …and in any case this long after it was created. */
const SESSION_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
/** Sliding expiry is refreshed at most this often. */
const TOUCH_EVERY_MS = 3600 * 1000;

export interface ActiveSession {
  idHash: string;
  scope: string;
  family: string;
  user: UserRow;
  /** The expiry just moved: the caller must send the cookie again, or the browser drops it at the old date. */
  renewed: boolean;
}

export function createSession(
  db: Db,
  input: { userId: number; scope: string; family: string; userAgent: string | null },
): { token: string } {
  const token = randomToken();
  const now = new Date();
  run(
    db,
    `INSERT INTO sessions (id_hash, user_id, scope, family, created_at, last_seen_at, expires_at, user_agent)
     VALUES (:id, :user, :scope, :family, :now, :now, :expires, :ua)`,
    {
      id: sha256(token),
      user: input.userId,
      scope: input.scope,
      family: input.family,
      now: now.toISOString(),
      expires: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      ua: input.userAgent?.slice(0, 300) ?? null,
    },
  );
  return { token };
}

/**
 * Resolves a session cookie for one scope. A session created for another host is
 * refused, and expiry and the e-mail allowlist are enforced on every use.
 */
export function resolveSession(
  db: Db,
  token: string,
  scope: string,
  isAllowed: (email: string) => boolean,
): ActiveSession | null {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const idHash = sha256(token);
  const row = get<{
    scope: string;
    family: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    u_id: number;
    email: string;
    name: string | null;
    google_sub: string | null;
    u_created: string;
    last_login_at: string | null;
  }>(
    db,
    `SELECT s.scope, s.family, s.created_at, s.last_seen_at, s.expires_at,
            u.id AS u_id, u.email, u.name, u.google_sub, u.created_at AS u_created, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = :id`,
    { id: idHash },
  );
  if (!row || row.scope !== scope) return null;
  const now = Date.now();
  const end = Math.min(Date.parse(row.expires_at), Date.parse(row.created_at) + SESSION_MAX_AGE_MS);
  if (end <= now || !isAllowed(row.email)) {
    run(db, 'DELETE FROM sessions WHERE id_hash = :id', { id: idHash });
    return null;
  }
  const renewed = now - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS;
  if (renewed) {
    run(db, 'UPDATE sessions SET last_seen_at = :now, expires_at = :expires WHERE id_hash = :id', {
      id: idHash,
      now: new Date(now).toISOString(),
      expires: new Date(now + SESSION_TTL_MS).toISOString(),
    });
  }
  return {
    idHash,
    scope: row.scope,
    family: row.family,
    renewed,
    user: {
      id: row.u_id,
      email: row.email,
      name: row.name,
      google_sub: row.google_sub,
      created_at: row.u_created,
      last_login_at: row.last_login_at,
    },
  };
}

/** Whether a session resolved earlier still stands (long-lived connections ask again from time to time). */
export function sessionStillValid(db: Db, session: ActiveSession, isAllowed: (email: string) => boolean): boolean {
  const row = get<{ expires_at: string; email: string }>(
    db,
    `SELECT s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = :id`,
    { id: session.idHash },
  );
  return row !== undefined && Date.parse(row.expires_at) > Date.now() && isAllowed(row.email);
}

const FAMILY_TABLES = ['sessions', 'sso_codes', 'push_subscriptions'] as const;

/** Signing out on any host ends the sign-in everywhere on that browser, notifications included. */
export function deleteFamily(db: Db, family: string): void {
  for (const table of FAMILY_TABLES) run(db, `DELETE FROM ${table} WHERE family = :family`, { family });
}

/**
 * Called when someone signs in on a browser: whatever another member left there
 * (sessions on app hosts, notifications) ends now. The same member signing in
 * again keeps theirs.
 */
export function claimFamily(db: Db, family: string, userId: number): void {
  for (const table of FAMILY_TABLES) {
    run(db, `DELETE FROM ${table} WHERE family = :family AND user_id != :user`, { family, user: userId });
  }
}

export function purgeExpired(db: Db): void {
  const now = new Date();
  run(db, 'DELETE FROM sessions WHERE expires_at <= :now OR created_at <= :oldest', {
    now: now.toISOString(),
    oldest: new Date(now.getTime() - SESSION_MAX_AGE_MS).toISOString(),
  });
  run(db, 'DELETE FROM sso_codes WHERE expires_at <= :now', { now: now.toISOString() });
}
