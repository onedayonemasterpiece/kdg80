import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmailSendResult } from './email-notifications';
import { computeFingerprint } from '../lib/crypto';

export type EmailEntityType = 'registration' | 'special_application';

export type RecordEmailNotificationInput = {
  entityType: EmailEntityType;
  entityId: number;
  template: string;
  recipientEmail: string;
  subject: string;
  configurationSetName: string | null;
  fingerprintSecret: string | null;
  result: EmailSendResult;
};

function nowIso() {
  return new Date().toISOString();
}

function recipientDomain(email: string) {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  return domain || null;
}

export function recordEmailNotification(db: Database.Database, input: RecordEmailNotificationInput) {
  const sentAt = input.result.sent ? nowIso() : null;
  const status = input.result.sent ? 'accepted' : 'send_failed';
  const emailFingerprint = input.fingerprintSecret
    ? computeFingerprint(input.fingerprintSecret, input.recipientEmail.trim().toLowerCase())
    : null;

  db.prepare(`
    INSERT INTO email_notifications (
      entity_type,
      entity_id,
      template,
      provider,
      provider_configuration_set,
      provider_message_id,
      recipient_email_fingerprint,
      recipient_domain,
      subject,
      status,
      reason,
      sent_at,
      last_event_at,
      updated_at
    ) VALUES (
      @entityType,
      @entityId,
      @template,
      @provider,
      @configurationSetName,
      @messageId,
      @emailFingerprint,
      @recipientDomain,
      @subject,
      @status,
      @reason,
      @sentAt,
      @eventAt,
      @eventAt
    )
  `).run({
    entityType: input.entityType,
    entityId: input.entityId,
    template: input.template,
    provider: input.result.provider,
    configurationSetName: input.configurationSetName,
    messageId: input.result.messageId,
    emailFingerprint,
    recipientDomain: recipientDomain(input.recipientEmail),
    subject: input.subject,
    status,
    reason: input.result.reason ?? null,
    sentAt,
    eventAt: sentAt ?? nowIso(),
  });
}

export type PostboxEventInput = Record<string, unknown>;

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstRecipientDomain(event: Record<string, unknown>) {
  const mail = objectField(event.mail);
  const headers = objectField(mail?.commonHeaders);
  const to = Array.isArray(headers?.to) ? headers.to : [];
  const recipient = to.find((item) => typeof item === 'string') as string | undefined;
  if (!recipient) {
    const delivery = objectField(event.delivery);
    const recipients = Array.isArray(delivery?.recipients) ? delivery.recipients : [];
    const delivered = recipients.find((item) => typeof item === 'string') as string | undefined;
    return delivered ? recipientDomain(delivered) : null;
  }
  const match = recipient.match(/@([^>\s]+)>?$/u);
  return match?.[1]?.toLowerCase() ?? recipientDomain(recipient);
}

function eventTimestamp(event: Record<string, unknown>, eventType: string) {
  const lower = eventType.toLowerCase();
  const specific = objectField(event[lower]);
  const delivery = objectField(event.delivery);
  const bounce = objectField(event.bounce);
  const complaint = objectField(event.complaint);
  const subscription = objectField(event.subscription);
  const mail = objectField(event.mail);
  return stringField(specific?.timestamp)
    ?? stringField(delivery?.timestamp)
    ?? stringField(bounce?.timestamp)
    ?? stringField(complaint?.timestamp)
    ?? stringField(subscription?.timestamp)
    ?? stringField(mail?.timestamp)
    ?? nowIso();
}

function statusForEvent(eventType: string) {
  switch (eventType.toUpperCase()) {
    case 'DELIVERY': return 'delivered';
    case 'BOUNCE': return 'bounced';
    case 'DELIVERY_DELAY': return 'delivery_delayed';
    case 'OPEN': return 'opened';
    case 'CLICK': return 'clicked';
    case 'COMPLAINT': return 'complained';
    case 'SUBSCRIPTION': return 'unsubscribed';
    case 'SEND': return 'accepted';
    default: return null;
  }
}

function hashUrl(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function recordPostboxEvent(db: Database.Database, event: PostboxEventInput) {
  const record = event as Record<string, unknown>;
  const eventType = stringField(record.eventType)?.toUpperCase();
  const eventId = stringField(record.eventId);
  const mail = objectField(record.mail);
  const messageId = stringField(mail?.messageId);
  if (!eventType || !messageId) {
    return { recorded: false, reason: 'missing_event_type_or_message_id' };
  }

  const notification = db.prepare('SELECT id FROM email_notifications WHERE provider_message_id = ?').get(messageId) as { id: number } | undefined;
  const eventAt = eventTimestamp(record, eventType);
  const click = objectField(record.click);
  const bounce = objectField(record.bounce);
  const bouncedRecipients = Array.isArray(bounce?.bouncedRecipients) ? bounce.bouncedRecipients : [];
  const firstBouncedRecipient = objectField(bouncedRecipients[0]);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO email_notification_events (
      notification_id,
      provider,
      provider_message_id,
      provider_event_id,
      event_type,
      event_at,
      recipient_domain,
      link_url_hash,
      diagnostic_code,
      status_code
    ) VALUES (?, 'yandex-postbox', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    notification?.id ?? null,
    messageId,
    eventId,
    eventType,
    eventAt,
    firstRecipientDomain(record),
    hashUrl(click?.link),
    stringField(firstBouncedRecipient?.diagnosticCode),
    stringField(firstBouncedRecipient?.status),
  );

  if (notification && result.changes > 0) {
    const status = statusForEvent(eventType);
    if (status) {
      db.prepare(`
        UPDATE email_notifications
        SET status = CASE
              WHEN status IN ('bounced', 'complained', 'unsubscribed') THEN status
              ELSE @status
            END,
            first_delivered_at = CASE WHEN @status = 'delivered' AND first_delivered_at IS NULL THEN @eventAt ELSE first_delivered_at END,
            last_opened_at = CASE WHEN @status = 'opened' THEN @eventAt ELSE last_opened_at END,
            last_clicked_at = CASE WHEN @status = 'clicked' THEN @eventAt ELSE last_clicked_at END,
            last_event_at = @eventAt,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({ id: notification.id, status, eventAt, updatedAt: nowIso() });
    }
  }

  return { recorded: result.changes > 0, notificationId: notification?.id ?? null };
}

export function buildEmailStatsReport(db: Database.Database, options: { from: string; to: string }) {
  const params = { from: options.from, to: options.to };
  const totals = db.prepare(`
    SELECT
      count(*) AS total,
      sum(CASE WHEN status != 'send_failed' THEN 1 ELSE 0 END) AS accepted,
      sum(CASE WHEN status = 'send_failed' THEN 1 ELSE 0 END) AS send_failed,
      sum(CASE WHEN first_delivered_at IS NOT NULL OR status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) AS delivered,
      sum(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      sum(CASE WHEN last_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      sum(CASE WHEN last_clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
    FROM email_notifications
    WHERE created_at >= @from AND created_at < @to
  `).get(params);

  const byTemplate = db.prepare(`
    SELECT template, count(*) AS total,
      sum(CASE WHEN status != 'send_failed' THEN 1 ELSE 0 END) AS accepted,
      sum(CASE WHEN first_delivered_at IS NOT NULL OR status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) AS delivered,
      sum(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      sum(CASE WHEN last_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      sum(CASE WHEN last_clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
    FROM email_notifications
    WHERE created_at >= @from AND created_at < @to
    GROUP BY template
    ORDER BY template
  `).all(params);

  const rows = db.prepare(`
    SELECT id, entity_type AS entityType, entity_id AS entityId, template, provider_message_id AS messageId,
      recipient_domain AS recipientDomain, subject, status, reason, sent_at AS sentAt,
      first_delivered_at AS firstDeliveredAt, last_opened_at AS lastOpenedAt, last_clicked_at AS lastClickedAt,
      created_at AS createdAt
    FROM email_notifications
    WHERE created_at >= @from AND created_at < @to
    ORDER BY created_at DESC, id DESC
  `).all(params);

  const eventsByType = db.prepare(`
    SELECT event_type AS eventType, count(*) AS count
    FROM email_notification_events
    WHERE event_at >= @from AND event_at < @to
    GROUP BY event_type
    ORDER BY event_type
  `).all(params);

  return { from: options.from, to: options.to, totals, byTemplate, eventsByType, rows };
}
