ALTER TABLE special_events
  ADD COLUMN previous_winner_weight_percent INTEGER NOT NULL DEFAULT 0 CHECK (previous_winner_weight_percent >= 0 AND previous_winner_weight_percent <= 100);

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
  'yantar-excursion',
  'Экскурсия на судостроительный завод ОСК «Янтарь»',
  'экскурсия на судостроительный завод',
  'ПСЗ «Янтарь»',
  'yantar-excursion-20260716',
  'open',
  5,
  10,
  2,
  3,
  3,
  50
);

UPDATE special_events
SET previous_winner_weight_percent = 50,
    public_state = 'open',
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'yantar-excursion';

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
SELECT id, '2026-07-16-1800', '2026-07-16T18:00:00+02:00', '16 июля 18:00 ПСЗ «Янтарь»', 1, 22, 10, 12
FROM special_events
WHERE slug = 'yantar-excursion';

UPDATE special_event_showings
SET slug = '2026-07-16-1800',
    starts_at = '2026-07-16T18:00:00+02:00',
    display_label = '16 июля 18:00 ПСЗ «Янтарь»',
    time_is_final = 1,
    physical_quota = 22,
    reserved_seats = 10,
    lottery_quota = 12,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug IN ('2026-07-16-1700', '2026-07-16-1800')
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'yantar-excursion'
    LIMIT 1
  );
