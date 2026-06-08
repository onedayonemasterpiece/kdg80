ALTER TABLE special_applications
  ADD COLUMN volunteer_bonus_points INTEGER NOT NULL DEFAULT 0 CHECK (volunteer_bonus_points >= 0);

ALTER TABLE special_applications
  ADD COLUMN volunteer_match_json TEXT NOT NULL DEFAULT '{}';

UPDATE special_event_showings
SET reserved_seats = 3,
    lottery_quota = 27,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-11-1800'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
  );

UPDATE special_event_showings
SET slug = '2026-06-23',
    starts_at = '2026-06-23T18:00:00+02:00',
    display_label = '23 июня Южный Вокзал',
    time_is_final = 0,
    physical_quota = 30,
    reserved_seats = 0,
    lottery_quota = 30,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-16-test'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM special_event_showings existing
    INNER JOIN special_events e ON e.id = existing.special_event_id
    WHERE e.slug = 'etudy-toy-vesny'
      AND existing.slug = '2026-06-23'
  );

UPDATE special_event_showings
SET slug = '2026-06-25',
    starts_at = '2026-06-25T18:00:00+02:00',
    display_label = '25 июня Южный Вокзал',
    time_is_final = 0,
    physical_quota = 30,
    reserved_seats = 0,
    lottery_quota = 30,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-21-test'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM special_event_showings existing
    INNER JOIN special_events e ON e.id = existing.special_event_id
    WHERE e.slug = 'etudy-toy-vesny'
      AND existing.slug = '2026-06-25'
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
SELECT id, '2026-06-23', '2026-06-23T18:00:00+02:00', '23 июня Южный Вокзал', 0, 30, 0, 30
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
SELECT id, '2026-06-25', '2026-06-25T18:00:00+02:00', '25 июня Южный Вокзал', 0, 30, 0, 30
FROM special_events
WHERE slug = 'etudy-toy-vesny';
