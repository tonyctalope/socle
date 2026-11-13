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

  /* 2 — apps become versions of source files, built by the runner */ `
  -- What an agent sent (files) and what the runner made of it. A version is never
  -- edited; publishing an app points apps.live_version at one of its versions.
  CREATE TABLE app_versions (
    -- AUTOINCREMENT: an id is never given twice, even after old versions are deleted.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_hash TEXT NOT NULL,
    asset_hash TEXT NOT NULL,
    files TEXT NOT NULL,
    manifest TEXT NOT NULL,
    web_js TEXT NOT NULL,
    web_css TEXT NOT NULL,
    server_bundle TEXT,
    bundle_hash TEXT,
    functions TEXT NOT NULL,
    migrations TEXT NOT NULL
  );
  CREATE INDEX app_versions_app ON app_versions(app, id);
  CREATE INDEX app_versions_assets ON app_versions(app, asset_hash);
  ALTER TABLE apps ADD COLUMN live_version INTEGER REFERENCES app_versions(id) ON DELETE SET NULL;
  `,
  /* 3 — sign-in is any OpenID Connect provider: the column holds its `sub` claim */ `
  ALTER TABLE users RENAME COLUMN google_sub TO subject;
  `,
  /* 4 — drafts: what agents edit, built and served apart from the published version */ `
  -- The working copy of an app. Building it gives a version (apps.draft_version) that only
  -- the app's draft address serves, on a database of its own. \`problems\` is what the last
  -- build said (JSON), null when it built.
  CREATE TABLE app_drafts (
    app TEXT PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,
    files TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    problems TEXT
  );
  ALTER TABLE apps ADD COLUMN draft_version INTEGER REFERENCES app_versions(id) ON DELETE SET NULL;
  ALTER TABLE apps ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  -- Set when a version becomes the published one. Versions that were only ever drafts are not history.
  ALTER TABLE app_versions ADD COLUMN published_at TEXT;
  UPDATE app_versions SET published_at = created_at;

  -- What an app's functions logged or failed with, for whoever writes the app. target: 'live' or 'draft'.
  CREATE TABLE app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
    target TEXT NOT NULL,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    fn TEXT,
    message TEXT NOT NULL
  );
  CREATE INDEX app_logs_app ON app_logs(app, id);
  `,
];
