import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import type { Config } from '../config.ts';
import { all, get, run, type Db } from '../db/database.ts';

export interface PushMessage {
  title: string;
  body: string;
  /** Path inside the app to open on tap. */
  url: string;
  /** Same tag = replaces the previous notification. */
  tag: string;
}

export interface PushService {
  readonly publicKey: string;
  /** Sends to every device the user enabled for this app; returns how many accepted it. */
  sendToUser(userId: number, app: string, message: PushMessage): Promise<number>;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

type Sender = typeof sendNotification;

// Browsers' push services. Anything else is refused so a subscription cannot
// make the server POST to arbitrary URLs.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

/** Narrows an untrusted JSON body to a subscription for a known push service. */
export function parseSubscription(body: unknown): SubscriptionInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || typeof keys !== 'object' || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const valid =
    url.protocol === 'https:' &&
    endpoint.length <= 1000 &&
    PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) &&
    /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p256dh) &&
    /^[A-Za-z0-9_-]{16,32}={0,2}$/.test(auth);
  return valid ? { endpoint, keys: { p256dh, auth } } : null;
}

/** VAPID keys come from the environment, or are generated once and kept in the database. */
export function vapidKeys(db: Db, config: Config): { publicKey: string; privateKey: string } {
  if (config.vapid.publicKey && config.vapid.privateKey) {
    return { publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey };
  }
  const stored = get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'vapid'");
  if (stored) return JSON.parse(stored.value) as { publicKey: string; privateKey: string };
  const keys = generateVAPIDKeys();
  run(db, "INSERT INTO settings (key, value) VALUES ('vapid', :value)", { value: JSON.stringify(keys) });
  return keys;
}

export function createPushService(db: Db, config: Config, sender: Sender = sendNotification): PushService {
  const keys = vapidKeys(db, config);
  return {
    publicKey: keys.publicKey,
    async sendToUser(userId, app, message) {
      const subscriptions = all<{ id: number; endpoint: string; p256dh: string; auth: string; failures: number }>(
        db,
        'SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = :user AND app = :app',
        { user: userId, app },
      );
      let delivered = 0;
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await sender(
              { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
              JSON.stringify(message),
              {
                vapidDetails: { subject: config.vapid.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
                TTL: 12 * 3600,
                urgency: 'normal',
                timeout: 15_000,
              },
            );
            delivered++;
            run(db, 'UPDATE push_subscriptions SET last_success_at = :now, failures = 0 WHERE id = :id', {
              now: new Date().toISOString(),
              id: subscription.id,
            });
          } catch (error) {
            const status = error instanceof WebPushError ? error.statusCode : 0;
            if (status === 404 || status === 410 || subscription.failures >= 9) {
              run(db, 'DELETE FROM push_subscriptions WHERE id = :id', { id: subscription.id });
            } else {
              run(db, 'UPDATE push_subscriptions SET failures = failures + 1 WHERE id = :id', { id: subscription.id });
            }
            console.warn(`push to subscription ${subscription.id} failed (${status || (error as Error).message})`);
          }
        }),
      );
      return delivered;
    },
  };
}

/** One member rarely has more devices than this on one app; older ones make room. */
export const MAX_SUBSCRIPTIONS = 10;

export function saveSubscription(
  db: Db,
  target: { userId: number; app: string; family: string },
  input: SubscriptionInput,
  userAgent: string | null,
): void {
  // The same endpoint posted again (another member signed in on this browser, or a
  // page reload) moves the row: a browser's subscription follows whoever uses it.
  run(
    db,
    `INSERT INTO push_subscriptions (user_id, app, family, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (:user, :app, :family, :endpoint, :p256dh, :auth, :ua, :now)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = :user, app = :app, family = :family, p256dh = :p256dh, auth = :auth, user_agent = :ua,
       created_at = :now, failures = 0`,
    {
      user: target.userId,
      app: target.app,
      family: target.family,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      ua: userAgent?.slice(0, 300) ?? null,
      now: new Date().toISOString(),
    },
  );
  run(
    db,
    `DELETE FROM push_subscriptions WHERE user_id = :user AND app = :app AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = :user AND app = :app
       ORDER BY created_at DESC, id DESC LIMIT ${MAX_SUBSCRIPTIONS})`,
    { user: target.userId, app: target.app },
  );
}

export function deleteSubscription(db: Db, target: { userId: number; app: string }, endpoint: string): void {
  run(db, 'DELETE FROM push_subscriptions WHERE user_id = :user AND app = :app AND endpoint = :endpoint', {
    user: target.userId,
    app: target.app,
    endpoint,
  });
}

export function countSubscriptions(db: Db, target: { userId: number; app: string }): number {
  return (
    get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :user AND app = :app', {
      user: target.userId,
      app: target.app,
    })?.n ?? 0
  );
}
