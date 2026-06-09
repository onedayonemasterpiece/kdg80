UPDATE special_event_showings
SET starts_at = '2026-06-23T18:30:00+02:00',
    display_label = '23 июня 18:30 Южный Вокзал',
    time_is_final = 1,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-23'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
    LIMIT 1
  );

UPDATE special_event_showings
SET starts_at = '2026-06-25T18:30:00+02:00',
    display_label = '25 июня 18:30 Южный Вокзал',
    time_is_final = 1,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-25'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'etudy-toy-vesny'
    LIMIT 1
  );
