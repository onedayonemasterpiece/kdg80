CREATE TABLE IF NOT EXISTS vk_social_personal_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_key TEXT NOT NULL UNIQUE,
  vk_user_id INTEGER NOT NULL REFERENCES vk_social_actors(vk_user_id) ON DELETE CASCADE,
  application_id INTEGER NOT NULL REFERENCES special_applications(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES vk_social_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('first', 'delta')),
  since_activity_id INTEGER,
  until_activity_id INTEGER NOT NULL,
  activity_count INTEGER NOT NULL DEFAULT 0 CHECK (activity_count >= 0),
  social_bonus_points INTEGER NOT NULL DEFAULT 0,
  social_bonus_raw_points REAL NOT NULL DEFAULT 0,
  message_text TEXT NOT NULL,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS vk_social_personal_reports_user_status_idx
  ON vk_social_personal_reports(vk_user_id, status, until_activity_id);

CREATE INDEX IF NOT EXISTS vk_social_personal_reports_run_idx
  ON vk_social_personal_reports(run_id, status);
