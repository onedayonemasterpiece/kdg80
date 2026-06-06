CREATE TABLE IF NOT EXISTS special_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  format_label TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  preview_token TEXT NOT NULL UNIQUE,
  public_state TEXT NOT NULL DEFAULT 'preview' CHECK (public_state IN ('preview', 'open', 'closed')),
  min_stamp_count INTEGER NOT NULL DEFAULT 5 CHECK (min_stamp_count >= 0),
  base_points INTEGER NOT NULL DEFAULT 10 CHECK (base_points >= 0),
  extra_stamp_points INTEGER NOT NULL DEFAULT 2 CHECK (extra_stamp_points >= 0),
  no_show_grace_count INTEGER NOT NULL DEFAULT 3 CHECK (no_show_grace_count >= 0),
  no_show_penalty_points INTEGER NOT NULL DEFAULT 3 CHECK (no_show_penalty_points >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS special_event_showings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  special_event_id INTEGER NOT NULL REFERENCES special_events(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  display_label TEXT NOT NULL,
  time_is_final INTEGER NOT NULL DEFAULT 1 CHECK (time_is_final IN (0, 1)),
  physical_quota INTEGER NOT NULL CHECK (physical_quota >= 0),
  reserved_seats INTEGER NOT NULL DEFAULT 0 CHECK (reserved_seats >= 0),
  lottery_quota INTEGER NOT NULL CHECK (lottery_quota >= 0),
  draw_status TEXT NOT NULL DEFAULT 'not_started' CHECK (draw_status IN ('not_started', 'draft', 'published', 'final')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(special_event_id, slug)
);

CREATE TABLE IF NOT EXISTS special_participant_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name_fingerprint TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  phone_fingerprint TEXT NOT NULL,
  latest_stamp_count INTEGER NOT NULL DEFAULT 0 CHECK (latest_stamp_count >= 0),
  latest_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(full_name_fingerprint, email_fingerprint, phone_fingerprint)
);

CREATE TABLE IF NOT EXISTS special_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_code TEXT NOT NULL UNIQUE,
  special_event_id INTEGER NOT NULL REFERENCES special_events(id) ON DELETE CASCADE,
  participant_profile_id INTEGER REFERENCES special_participant_profiles(id) ON DELETE SET NULL,
  pii_ciphertext BLOB NOT NULL,
  pii_wrapped_key BLOB NOT NULL,
  pii_iv BLOB NOT NULL,
  pii_alg TEXT NOT NULL,
  full_name_fingerprint TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  phone_fingerprint TEXT NOT NULL,
  selected_showing_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejection_reason TEXT,
  uploaded_photo_count INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_photo_count >= 0),
  unique_photo_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_photo_count >= 0),
  accepted_photo_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_photo_count >= 0),
  stamp_count INTEGER NOT NULL DEFAULT 0 CHECK (stamp_count >= 0),
  ordinary_registration_count INTEGER NOT NULL DEFAULT 0 CHECK (ordinary_registration_count >= 0),
  no_show_count INTEGER NOT NULL DEFAULT 0 CHECK (no_show_count >= 0),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  ocr_provider TEXT NOT NULL,
  ocr_model TEXT,
  ocr_summary_json TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_text_hash TEXT NOT NULL,
  consent_accepted_at TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_full_name_idx
  ON special_applications(special_event_id, full_name_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_email_idx
  ON special_applications(special_event_id, email_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_phone_idx
  ON special_applications(special_event_id, phone_fingerprint);

CREATE TABLE IF NOT EXISTS special_application_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES special_applications(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  duplicate_of_sha256 TEXT,
  has_full_name INTEGER NOT NULL DEFAULT 0 CHECK (has_full_name IN (0, 1)),
  stamp_count INTEGER NOT NULL DEFAULT 0 CHECK (stamp_count >= 0),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  confidence REAL NOT NULL DEFAULT 0,
  ocr_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS special_application_showings (
  application_id INTEGER NOT NULL REFERENCES special_applications(id) ON DELETE CASCADE,
  showing_id INTEGER NOT NULL REFERENCES special_event_showings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(application_id, showing_id)
);

CREATE TABLE IF NOT EXISTS special_draw_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  showing_id INTEGER NOT NULL REFERENCES special_event_showings(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK (run_type IN ('draft', 'published')),
  snapshot_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO special_events(
  slug,
  title,
  format_label,
  venue_name,
  preview_token,
  public_state,
  min_stamp_count,
  base_points,
  extra_stamp_points,
  no_show_grace_count,
  no_show_penalty_points
) VALUES (
  'etudy-toy-vesny',
  'Этюды той весны',
  'иммерсивный спектакль',
  'Южный Вокзал',
  'etudy-toy-vesny-debug-20260606',
  'preview',
  5,
  10,
  2,
  3,
  3
);

INSERT OR IGNORE INTO special_event_showings(
  special_event_id,
  slug,
  starts_at,
  display_label,
  time_is_final,
  physical_quota,
  reserved_seats,
  lottery_quota
)
SELECT id, '2026-06-11-1800', '2026-06-11T18:00:00+02:00', '11 июня 18:00 Южный Вокзал', 1, 30, 1, 29
FROM special_events
WHERE slug = 'etudy-toy-vesny';

INSERT OR IGNORE INTO special_event_showings(
  special_event_id,
  slug,
  starts_at,
  display_label,
  time_is_final,
  physical_quota,
  reserved_seats,
  lottery_quota
)
SELECT id, '2026-06-16-test', '2026-06-16T18:00:00+02:00', '16 июня Южный Вокзал', 0, 30, 0, 30
FROM special_events
WHERE slug = 'etudy-toy-vesny';

INSERT OR IGNORE INTO special_event_showings(
  special_event_id,
  slug,
  starts_at,
  display_label,
  time_is_final,
  physical_quota,
  reserved_seats,
  lottery_quota
)
SELECT id, '2026-06-21-test', '2026-06-21T18:00:00+02:00', '21 июня Южный Вокзал', 0, 30, 0, 30
FROM special_events
WHERE slug = 'etudy-toy-vesny';
