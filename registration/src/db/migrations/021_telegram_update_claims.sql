CREATE TABLE IF NOT EXISTS telegram_update_claims (
  update_id INTEGER PRIMARY KEY,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS telegram_update_claims_claimed_at_idx
  ON telegram_update_claims(claimed_at);
