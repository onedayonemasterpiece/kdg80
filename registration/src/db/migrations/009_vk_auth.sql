CREATE TABLE IF NOT EXISTS vk_auth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  source_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS vk_auth_states_expires_at_idx
  ON vk_auth_states(expires_at);

CREATE TABLE IF NOT EXISTS vk_auth_sessions (
  token TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'vkid',
  vk_user_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  avatar_url TEXT,
  scope TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS vk_auth_sessions_vk_user_id_idx
  ON vk_auth_sessions(vk_user_id);

CREATE INDEX IF NOT EXISTS vk_auth_sessions_expires_at_idx
  ON vk_auth_sessions(expires_at);

ALTER TABLE special_applications
  ADD COLUMN vk_auth_provider TEXT;

ALTER TABLE special_applications
  ADD COLUMN vk_user_id_fingerprint TEXT;

ALTER TABLE special_applications
  ADD COLUMN vk_auth_verified_at TEXT;

ALTER TABLE special_applications
  ADD COLUMN vk_auth_scope TEXT;

CREATE INDEX IF NOT EXISTS special_applications_vk_user_id_fingerprint_idx
  ON special_applications(vk_user_id_fingerprint);
