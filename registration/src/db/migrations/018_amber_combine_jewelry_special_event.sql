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
  'amber-combine-jewelry-excursion',
  'Экскурсия на ювелирное производство Калининградского янтарного комбината',
  'экскурсия на ювелирное производство',
  'Калининградский янтарный комбинат',
  'amber-combine-jewelry-20260811',
  'open',
  5,
  10,
  2,
  3,
  3,
  0
);

UPDATE special_events
SET title = 'Экскурсия на ювелирное производство Калининградского янтарного комбината',
    format_label = 'экскурсия на ювелирное производство',
    venue_name = 'Калининградский янтарный комбинат',
    preview_token = 'amber-combine-jewelry-20260811',
    public_state = 'open',
    min_stamp_count = 5,
    base_points = 10,
    extra_stamp_points = 2,
    no_show_grace_count = 3,
    no_show_penalty_points = 3,
    previous_winner_weight_percent = 0,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'amber-combine-jewelry-excursion';

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
SELECT id,
       '2026-08-11-1100',
       '2026-08-11T11:00:00+02:00',
       '11 августа 11:00 · ювелирное производство Янтарного комбината',
       1,
       6,
       0,
       6
FROM special_events
WHERE slug = 'amber-combine-jewelry-excursion';

UPDATE special_event_showings
SET starts_at = '2026-08-11T11:00:00+02:00',
    display_label = '11 августа 11:00 · ювелирное производство Янтарного комбината',
    time_is_final = 1,
    physical_quota = 6,
    reserved_seats = 0,
    lottery_quota = 6,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = '2026-08-11-1100'
  AND special_event_id = (
    SELECT id
    FROM special_events
    WHERE slug = 'amber-combine-jewelry-excursion'
    LIMIT 1
  );
