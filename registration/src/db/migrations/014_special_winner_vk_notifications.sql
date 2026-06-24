ALTER TABLE special_event_showings
  ADD COLUMN meeting_place TEXT;

UPDATE special_event_showings
SET starts_at = '2026-06-25T18:10:00+02:00',
    display_label = '25 июня 18:10 Южный Вокзал',
    meeting_place = 'У фонтана в здании Южного вокзала',
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-25'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
  );

CREATE TABLE IF NOT EXISTS special_winner_vk_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_run_id INTEGER NOT NULL REFERENCES special_draw_runs(id) ON DELETE CASCADE,
  showing_id INTEGER NOT NULL REFERENCES special_event_showings(id) ON DELETE CASCADE,
  application_id INTEGER NOT NULL REFERENCES special_applications(id) ON DELETE CASCADE,
  vk_user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error TEXT,
  message_text TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(draw_run_id, application_id, vk_user_id)
);

CREATE INDEX IF NOT EXISTS special_winner_vk_notifications_draw_idx
  ON special_winner_vk_notifications(draw_run_id, status);
