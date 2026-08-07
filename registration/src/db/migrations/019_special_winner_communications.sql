ALTER TABLE special_events
  ADD COLUMN auto_draw_lead_hours INTEGER NOT NULL DEFAULT 24
  CHECK (auto_draw_lead_hours BETWEEN 1 AND 168);

ALTER TABLE special_events
  ADD COLUMN requires_russian_citizenship INTEGER NOT NULL DEFAULT 0
  CHECK (requires_russian_citizenship IN (0, 1));

ALTER TABLE special_events
  ADD COLUMN winner_email_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (winner_email_enabled IN (0, 1));

ALTER TABLE special_events
  ADD COLUMN winner_response_deadline_hours INTEGER NOT NULL DEFAULT 24
  CHECK (winner_response_deadline_hours BETWEEN 1 AND 168);

ALTER TABLE special_applications
  ADD COLUMN russian_citizenship_confirmed INTEGER NOT NULL DEFAULT 0
  CHECK (russian_citizenship_confirmed IN (0, 1));

UPDATE special_events
SET auto_draw_lead_hours = 48,
    requires_russian_citizenship = 1,
    winner_email_enabled = 1,
    winner_response_deadline_hours = 24,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'amber-combine-jewelry-excursion';


-- Applications accepted before this rule was published remain eligible;
-- Russian citizenship is finally verified by the passport details supplied by winners.
UPDATE special_applications
SET russian_citizenship_confirmed = 1
WHERE special_event_id = (
  SELECT id
  FROM special_events
  WHERE slug = 'amber-combine-jewelry-excursion'
  LIMIT 1
)
  AND status = 'accepted';
