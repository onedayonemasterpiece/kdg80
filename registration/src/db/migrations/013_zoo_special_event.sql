UPDATE special_events
SET public_state = 'open',
    previous_winner_weight_percent = 50,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'yantar-excursion';

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
  no_show_penalty_points,
  previous_winner_weight_percent
) VALUES (
  'zoo-excursion',
  'Премьера новой тематической экскурсии по Калининградскому зоопарку',
  'экскурсия',
  'Калининградский зоопарк',
  'zoo-excursion-20260628',
  'open',
  5,
  10,
  2,
  3,
  3,
  0
);

UPDATE special_events
SET title = 'Премьера новой тематической экскурсии по Калининградскому зоопарку',
    format_label = 'экскурсия',
    venue_name = 'Калининградский зоопарк',
    preview_token = 'zoo-excursion-20260628',
    public_state = 'open',
    min_stamp_count = 5,
    base_points = 10,
    extra_stamp_points = 2,
    no_show_grace_count = 3,
    no_show_penalty_points = 3,
    previous_winner_weight_percent = 0,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'zoo-excursion';

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
SELECT id, '2026-06-28-1400', '2026-06-28T14:00:00+02:00', '28 июня 14:00 Калининградский зоопарк', 1, 10, 0, 10
FROM special_events
WHERE slug = 'zoo-excursion';

UPDATE special_event_showings
SET starts_at = '2026-06-28T14:00:00+02:00',
    display_label = '28 июня 14:00 Калининградский зоопарк',
    time_is_final = 1,
    physical_quota = 10,
    reserved_seats = 0,
    lottery_quota = 10,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-06-28-1400'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'zoo-excursion'
    LIMIT 1
  );
