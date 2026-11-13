// Tables of the OAuth 2.1 authorization server (src/oauth), to be appended to MIGRATIONS.
// Same conventions as src/db/migrations.ts: ISO-8601 UTC timestamps as TEXT, and every
// secret (client secret, request id, code, token) stored only as its SHA-256 hash.

export const OAUTH_SCHEMA: string = `
  -- MCP clients: registered dynamically ('dcr') or described by a metadata document
  -- fetched from a trusted host ('cimd', client_id = the document's URL).
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                       -- 'dcr' | 'cimd'
    client_secret_hash TEXT,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,              -- JSON array
    token_endpoint_auth_method TEXT NOT NULL,
    registration TEXT NOT NULL,               -- JSON, as returned to the client (no secret)
    created_at TEXT NOT NULL,
    expires_at TEXT                           -- CIMD cache expiry
  );

  -- An authorization request waiting for the member's answer. session_hash is the browser
  -- session it belongs to; NULL only for a request too long to travel through sign-in,
  -- parked until the visitor comes back signed in (the only rows a visitor can create).
  CREATE TABLE oauth_requests (
    id_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    redirect_uri_provided INTEGER NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    session_hash TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX oauth_requests_session ON oauth_requests(session_hash);

  -- One member's authorization of one client for one protected resource (RFC 8707).
  -- Its tokens die with it.
  CREATE TABLE oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT,                         -- as the client declared it, NULL when it gave none
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX oauth_grants_user ON oauth_grants(user_id);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    redirect_uri_provided INTEGER NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    grant_id TEXT                             -- what the code produced, to revoke it on a replay
  );

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                       -- 'access' | 'refresh'
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    rotated_at TEXT                           -- refresh tokens: when exchanged
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
`;
