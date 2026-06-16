ALTER TABLE events ADD COLUMN overbooking_percent INTEGER NOT NULL DEFAULT 69;
ALTER TABLE events ADD COLUMN registration_limit INTEGER NOT NULL DEFAULT 0;

UPDATE halls
SET capacity = 220,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE code = 'kghm-conference-hall'
   OR (
     venue_name = 'Калининградский областной историко-художественный музей'
     AND hall_name = 'Конференц-зал'
   );

UPDATE events
SET capacity = 220,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE venue_name = 'Калининградский областной историко-художественный музей'
  AND hall_name = 'Конференц-зал';

UPDATE events
SET registration_limit = CAST((capacity * (100 + overbooking_percent)) / 100 AS INTEGER),
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
