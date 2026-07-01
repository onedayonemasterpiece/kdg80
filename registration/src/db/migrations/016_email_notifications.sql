CREATE TABLE IF NOT EXISTS email_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('registration', 'special_application')),
  entity_id INTEGER NOT NULL,
  template TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_configuration_set TEXT,
  provider_message_id TEXT UNIQUE,
  recipient_email_fingerprint TEXT,
  recipient_domain TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('send_attempted', 'accepted', 'send_failed', 'delivered', 'bounced', 'delivery_delayed', 'opened', 'clicked', 'complained', 'unsubscribed')),
  reason TEXT,
  sent_at TEXT,
  first_delivered_at TEXT,
  last_opened_at TEXT,
  last_clicked_at TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS email_notifications_entity_idx
  ON email_notifications(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS email_notifications_created_at_idx
  ON email_notifications(created_at);

CREATE INDEX IF NOT EXISTS email_notifications_status_idx
  ON email_notifications(status);

CREATE TABLE IF NOT EXISTS email_notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES email_notifications(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  provider_event_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  recipient_domain TEXT,
  link_url_hash TEXT,
  diagnostic_code TEXT,
  status_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS email_notification_events_message_idx
  ON email_notification_events(provider_message_id);

CREATE INDEX IF NOT EXISTS email_notification_events_type_at_idx
  ON email_notification_events(event_type, event_at);
