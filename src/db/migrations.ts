// Append-only: each entry runs once, in order, tracked by PRAGMA user_version.
// Timestamps are ISO-8601 UTC strings.

export const MIGRATIONS: readonly string[] = [
  /* 1 — accounts, sessions, sign-on between hosts, apps, push */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    google_sub TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  -- One row per browser and per host. scope = '' for the control plane, else the app's slug:
  -- a session is only ever accepted on the host it was created for.
  -- family = one browser (its device cookie on the control plane); signing out anywhere
  -- ends the whole family.
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    family TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_family ON sessions(family);

  -- One-time codes carrying a sign-in from the control plane to one app host.
  CREATE TABLE sso_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    family TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    next_path TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE apps (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    theme_color TEXT NOT NULL DEFAULT '#f4f1ea',
    background_color TEXT NOT NULL DEFAULT '#f4f1ea',
    created_at TEXT NOT NULL
  );

  -- A push subscription belongs to one browser on one app host, and ends with its family.
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    family TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_success_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX push_subscriptions_target ON push_subscriptions(user_id, app);
  CREATE INDEX push_subscriptions_family ON push_subscriptions(family);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
