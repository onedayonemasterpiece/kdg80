CREATE TABLE IF NOT EXISTS vk_social_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'dry_run')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  error TEXT,
  notifications_count INTEGER NOT NULL DEFAULT 0 CHECK (notifications_count >= 0),
  wall_post_count INTEGER NOT NULL DEFAULT 0 CHECK (wall_post_count >= 0),
  activity_count INTEGER NOT NULL DEFAULT 0 CHECK (activity_count >= 0),
  actor_count INTEGER NOT NULL DEFAULT 0 CHECK (actor_count >= 0),
  matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  weak_count INTEGER NOT NULL DEFAULT 0 CHECK (weak_count >= 0),
  ambiguous_count INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_count >= 0),
  unmatched_count INTEGER NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0),
  llm_request_count INTEGER NOT NULL DEFAULT 0 CHECK (llm_request_count >= 0),
  source_summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS vk_social_actors (
  vk_user_id INTEGER PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  is_closed INTEGER CHECK (is_closed IN (0, 1)),
  action_summary_json TEXT NOT NULL DEFAULT '[]',
  activity_count INTEGER NOT NULL DEFAULT 0 CHECK (activity_count >= 0),
  last_seen_at TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'weak', 'ambiguous', 'unmatched')),
  match_method TEXT,
  match_confidence REAL NOT NULL DEFAULT 0,
  matched_special_application_id INTEGER REFERENCES special_applications(id) ON DELETE SET NULL,
  match_reason TEXT,
  match_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS vk_social_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('like_post', 'comment_post', 'reply_comment', 'like_comment', 'repost_post', 'like_video')),
  vk_user_id INTEGER NOT NULL REFERENCES vk_social_actors(vk_user_id) ON DELETE CASCADE,
  group_id INTEGER,
  post_id INTEGER,
  comment_id INTEGER,
  activity_date TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS vk_social_activities_actor_idx
  ON vk_social_activities(vk_user_id);

CREATE INDEX IF NOT EXISTS vk_social_activities_object_idx
  ON vk_social_activities(group_id, post_id, comment_id);

CREATE TABLE IF NOT EXISTS vk_social_match_cache (
  vk_user_id INTEGER NOT NULL,
  vk_display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'weak', 'ambiguous', 'unmatched')),
  method TEXT NOT NULL CHECK (method IN ('deterministic', 'llm', 'none')),
  confidence REAL NOT NULL DEFAULT 0,
  matched_special_application_id INTEGER REFERENCES special_applications(id) ON DELETE SET NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  reason TEXT,
  llm_model TEXT,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(vk_user_id, vk_display_name)
);
