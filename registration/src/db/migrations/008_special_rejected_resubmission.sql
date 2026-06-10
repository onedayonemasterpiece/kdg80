DROP INDEX IF EXISTS special_applications_event_full_name_idx;
DROP INDEX IF EXISTS special_applications_event_email_idx;
DROP INDEX IF EXISTS special_applications_event_phone_idx;

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_full_name_accepted_idx
  ON special_applications(special_event_id, full_name_fingerprint)
  WHERE status = 'accepted';

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_email_accepted_idx
  ON special_applications(special_event_id, email_fingerprint)
  WHERE status = 'accepted';

CREATE UNIQUE INDEX IF NOT EXISTS special_applications_event_phone_accepted_idx
  ON special_applications(special_event_id, phone_fingerprint)
  WHERE status = 'accepted';
