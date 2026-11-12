import { get, run, transaction, type Db } from '../db/database.ts';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.ts';

// Sign-on between hosts. Cookies are host-only, so a sign-in on the control plane
// reaches an app host through a one-time code:
//
//   app host   /_socle/login   sets a random state cookie, sends the browser to the control plane
//   control    /sso/start      checks the session and the access right, issues a code for THAT app
//   app host   /_socle/sso     trades the code for its own session cookie
//
// A code is single-use, lives one minute, only works on the host it was issued for,
// and only in the browser that started the flow (it is bound to the state cookie).

/** Cookie holding the state on the app host while the browser visits the control plane. */
export const SSO_COOKIE = 'socle_sso';
export const SSO_STATE_TTL_SEC = 600;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 5000;

export const isToken = (value: string): boolean => /^[A-Za-z0-9_-]{20,100}$/.test(value);

/** Only signed-in members reach this, so the table cannot be filled anonymously. */
export function createSsoCode(
  db: Db,
  input: { userId: number; app: string; family: string; state: string; nextPath: string },
  now: Date,
): string | null {
  const pending = () => get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sso_codes')?.n ?? 0;
  if (pending() >= MAX_PENDING) {
    run(db, 'DELETE FROM sso_codes WHERE expires_at <= :now', { now: now.toISOString() });
    if (pending() >= MAX_PENDING) return null;
  }
  const code = randomToken();
  run(
    db,
    `INSERT INTO sso_codes (code_hash, user_id, app, family, state_hash, next_path, expires_at)
     VALUES (:code, :user, :app, :family, :state, :next, :expires)`,
    {
      code: sha256(code),
      user: input.userId,
      app: input.app,
      family: input.family,
      state: sha256(input.state),
      next: input.nextPath,
      expires: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    },
  );
  return code;
}

export interface SsoGrant {
  userId: number;
  family: string;
  nextPath: string;
  /** False when the browser did not present the state the code was issued for. */
  stateMatches: boolean;
}

/**
 * Takes a code out of the table. It is deleted whatever the outcome, so a failed
 * attempt burns it. Returns null unless the code exists, is still fresh and was
 * issued for this app; the caller decides what a state mismatch means.
 */
export function takeSsoCode(
  db: Db,
  input: { code: string; app: string; state: string | undefined },
  now: Date,
): SsoGrant | null {
  if (!isToken(input.code)) return null;
  const codeHash = sha256(input.code);
  const row = transaction(db, () => {
    const found = get<{
      user_id: number;
      app: string;
      family: string;
      state_hash: string;
      next_path: string;
      expires_at: string;
    }>(db, 'SELECT user_id, app, family, state_hash, next_path, expires_at FROM sso_codes WHERE code_hash = :code', {
      code: codeHash,
    });
    run(db, 'DELETE FROM sso_codes WHERE code_hash = :code', { code: codeHash });
    return found;
  });
  if (!row || row.app !== input.app || Date.parse(row.expires_at) <= now.getTime()) return null;
  return {
    userId: row.user_id,
    family: row.family,
    nextPath: row.next_path,
    stateMatches: input.state !== undefined && isToken(input.state) && safeEqual(row.state_hash, sha256(input.state)),
  };
}
