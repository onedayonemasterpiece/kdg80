CREATE TABLE IF NOT EXISTS vk_social_activity_email_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_key TEXT NOT NULL UNIQUE,
  application_id INTEGER NOT NULL REFERENCES special_applications(id) ON DELETE CASCADE,
  showing_id INTEGER NOT NULL REFERENCES special_event_showings(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  recipient_email_fingerprint TEXT,
  social_bonus_points INTEGER NOT NULL DEFAULT 0,
  social_bonus_raw_points REAL NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  inactive_since_at TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS vk_social_activity_email_reminders_application_idx
  ON vk_social_activity_email_reminders(application_id, status);

CREATE INDEX IF NOT EXISTS vk_social_activity_email_reminders_showing_idx
  ON vk_social_activity_email_reminders(showing_id, status);
