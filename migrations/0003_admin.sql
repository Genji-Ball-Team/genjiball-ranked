-- Admins and the log of what they do (#7). See docs/api.md, "Admin".

-- An admin signs in with a token. Only the SHA-256 of the token is stored, like a host's. The first
-- admin is added with SQL (`npm run admin:token`); revoke one by setting `revoked_at`.
CREATE TABLE admins (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,            -- shown in the action log
  token_hash TEXT NOT NULL UNIQUE,            -- hex SHA-256 of the bearer token
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  revoked_at TEXT                             -- set: the token no longer works
);

-- Every admin action: who, what, when, and which match or host. Never updated or deleted.
CREATE TABLE admin_actions (
  id       INTEGER PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  action   TEXT NOT NULL,                     -- host_create, host_trust, match_accept, ... (docs/api.md)
  match_id INTEGER REFERENCES matches(id),
  host_id  INTEGER REFERENCES hosts(id),
  detail   TEXT,                              -- JSON: the old and new trust, the reason given, ...
  at       TEXT NOT NULL
);
