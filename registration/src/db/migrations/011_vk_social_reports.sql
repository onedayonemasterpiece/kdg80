CREATE TABLE IF NOT EXISTS vk_social_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('delta', 'rolling')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  run_id INTEGER REFERENCES vk_social_runs(id) ON DELETE SET NULL,
  since_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  since_exclusive INTEGER NOT NULL DEFAULT 1 CHECK (since_exclusive IN (0, 1)),
  text_hash TEXT NOT NULL,
  telegram_message_count INTEGER NOT NULL DEFAULT 0 CHECK (telegram_message_count >= 0),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS vk_social_reports_mode_status_until_idx
  ON vk_social_reports(mode, status, until_at);

CREATE INDEX IF NOT EXISTS vk_social_reports_run_idx
  ON vk_social_reports(run_id);
