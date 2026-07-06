import type Database from 'better-sqlite3';
import { computeFingerprint, decryptPii } from '../lib/crypto';
import type { EmailNotificationService, EmailSendResult } from './email-notifications';
import { recordEmailNotification } from './email-stats';
import { loadSocialRaffleBonuses } from './special-social-scoring';

export const SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE = 'special_social_activity_reminder';
const MATCH_CONFIDENCE_MIN = 0.85;

type ReminderApplicationRow = {
  application_id: number;
  application_code: string;
  pii_ciphertext: Buffer;
  pii_wrapped_key: Buffer;
  pii_iv: Buffer;
  pii_alg: string;
  event_title: string;
  event_venue_name: string;
  showing_id: number;
  showing_display_label: string;
  showing_starts_at: string;
  latest_activity_at: string | null;
  recent_activity_count: number;
  already_reminded: number;
};

export type SpecialSocialActivityReminderCandidate = {
  applicationId: number;
  applicationCode: string;
  fullName: string;
  email: string;
  event: {
    title: string;
    venueName: string;
  };
  showing: {
    id: number;
    displayLabel: string;
    startsAt: string;
  };
  social: {
    bonusPoints: number;
    rawPoints: number;
    latestActivityAt: string | null;
    inactiveSinceAt: string;
    inactiveDays: number;
  };
  reminderKey: string;
};

export type ListSpecialSocialActivityReminderCandidatesOptions = {
  privateKeyPemBase64: string;
  now?: Date;
  inactiveDays?: number;
  limit?: number;
};

export type SendSpecialSocialActivityRemindersOptions = ListSpecialSocialActivityReminderCandidatesOptions & {
  emailNotifications: EmailNotificationService;
  fingerprintSecret: string | null;
  postboxConfigurationSetName: string | null;
  dryRun?: boolean;
};

export type SendSpecialSocialActivityReminderItem = {
  applicationId: number;
  applicationCode: string;
  emailDomain: string | null;
  eventTitle: string;
  showingLabel: string;
  socialBonusPoints: number;
  latestActivityAt: string | null;
  sent: boolean;
  messageId: string | null;
  reason: string | null;
};

function tableExists(db: Database.Database, tableName: string) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function emailDomain(email: string) {
  return email.split('@')[1]?.trim().toLowerCase() || null;
}

function toIso(value: Date) {
  return value.toISOString();
}

function inactiveSince(now: Date, inactiveDays: number) {
  return new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000).toISOString();
}

function reminderKey(applicationId: number, showingId: number) {
  return `${SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE}:${applicationId}:${showingId}`;
}

function buildFailureResult(error: unknown): EmailSendResult {
  return {
    sent: false,
    provider: 'yandex-postbox',
    messageId: null,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function listRawReminderRows(
  db: Database.Database,
  options: Required<Pick<ListSpecialSocialActivityReminderCandidatesOptions, 'now' | 'inactiveDays' | 'limit'>>,
) {
  if (!tableExists(db, 'special_applications') || !tableExists(db, 'special_event_showings')) {
    return [] as ReminderApplicationRow[];
  }
  const hasReminderLedger = tableExists(db, 'vk_social_activity_email_reminders');
  const hasSocialTables = tableExists(db, 'vk_social_actors') && tableExists(db, 'vk_social_activities');
  const nowIso = toIso(options.now);
  const inactiveSinceIso = inactiveSince(options.now, options.inactiveDays);

  const socialJoin = hasSocialTables
    ? `
      LEFT JOIN vk_social_actors actor
        ON actor.matched_special_application_id = a.id
       AND actor.match_status = 'matched'
       AND actor.match_confidence >= @matchConfidenceMin
      LEFT JOIN vk_social_activities act
        ON act.vk_user_id = actor.vk_user_id
    `
    : '';
  const latestActivitySelect = hasSocialTables
    ? 'MAX(COALESCE(act.activity_date, act.created_at)) AS latest_activity_at'
    : 'NULL AS latest_activity_at';
  const recentActivitySelect = hasSocialTables
    ? `SUM(CASE
         WHEN COALESCE(act.activity_date, act.created_at) IS NOT NULL
          AND datetime(COALESCE(act.activity_date, act.created_at)) >= datetime(@inactiveSince)
         THEN 1 ELSE 0 END) AS recent_activity_count`
    : '0 AS recent_activity_count';
  const reminderJoin = hasReminderLedger
    ? `
      LEFT JOIN vk_social_activity_email_reminders reminder
        ON reminder.reminder_key = ('${SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE}' || ':' || a.id || ':' || s.id)
       AND reminder.status = 'sent'
    `
    : '';
  const remindedSelect = hasReminderLedger ? 'CASE WHEN reminder.id IS NULL THEN 0 ELSE 1 END AS already_reminded' : '0 AS already_reminded';

  const rows = db.prepare(`
    SELECT
      a.id AS application_id,
      a.application_code,
      a.pii_ciphertext,
      a.pii_wrapped_key,
      a.pii_iv,
      a.pii_alg,
      e.title AS event_title,
      e.venue_name AS event_venue_name,
      s.id AS showing_id,
      s.display_label AS showing_display_label,
      s.starts_at AS showing_starts_at,
      ${latestActivitySelect},
      ${recentActivitySelect},
      ${remindedSelect}
    FROM special_applications a
    INNER JOIN special_application_showings aps ON aps.application_id = a.id
    INNER JOIN special_event_showings s ON s.id = aps.showing_id
    INNER JOIN special_events e ON e.id = s.special_event_id
    ${socialJoin}
    ${reminderJoin}
    WHERE a.status = 'accepted'
      AND a.score > 0
      AND s.lottery_quota > 0
      AND s.draw_status NOT IN ('published', 'final')
      AND datetime(s.starts_at) > datetime(@now)
    GROUP BY a.id, s.id
    HAVING recent_activity_count = 0
       AND already_reminded = 0
    ORDER BY datetime(s.starts_at) ASC, a.created_at ASC, a.id ASC
  `).all({
    now: nowIso,
    inactiveSince: inactiveSinceIso,
    matchConfidenceMin: MATCH_CONFIDENCE_MIN,
  }) as ReminderApplicationRow[];

  const byApplication = new Map<number, ReminderApplicationRow>();
  for (const row of rows) {
    if (!byApplication.has(row.application_id)) {
      byApplication.set(row.application_id, row);
    }
    if (byApplication.size >= options.limit) {
      break;
    }
  }
  return [...byApplication.values()];
}

export function listSpecialSocialActivityReminderCandidates(
  db: Database.Database,
  options: ListSpecialSocialActivityReminderCandidatesOptions,
) {
  const inactiveDays = Math.max(1, Math.trunc(options.inactiveDays ?? 5));
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.trunc(options.limit ?? 100));
  const rows = listRawReminderRows(db, { now, inactiveDays, limit });
  const bonuses = loadSocialRaffleBonuses(db, rows.map((row) => row.application_id));
  const inactiveSinceAt = inactiveSince(now, inactiveDays);

  return rows.flatMap((row) => {
    try {
      const pii = decryptPii(options.privateKeyPemBase64, {
        piiCiphertext: row.pii_ciphertext,
        piiWrappedKey: row.pii_wrapped_key,
        piiIv: row.pii_iv,
        piiAlg: row.pii_alg,
      });
      const email = pii.email ?? '';
      if (!email) {
        return [];
      }
      const bonus = bonuses.get(row.application_id);
      return [{
        applicationId: row.application_id,
        applicationCode: row.application_code,
        fullName: pii.fullName ?? '',
        email,
        event: {
          title: row.event_title,
          venueName: row.event_venue_name,
        },
        showing: {
          id: row.showing_id,
          displayLabel: row.showing_display_label,
          startsAt: row.showing_starts_at,
        },
        social: {
          bonusPoints: bonus?.bonusPoints ?? 0,
          rawPoints: bonus?.rawPoints ?? 0,
          latestActivityAt: row.latest_activity_at,
          inactiveSinceAt,
          inactiveDays,
        },
        reminderKey: reminderKey(row.application_id, row.showing_id),
      } satisfies SpecialSocialActivityReminderCandidate];
    } catch {
      return [];
    }
  });
}

function recordReminderLedger(
  db: Database.Database,
  candidate: SpecialSocialActivityReminderCandidate,
  fingerprintSecret: string | null,
  result: EmailSendResult,
) {
  const emailFingerprint = fingerprintSecret
    ? computeFingerprint(fingerprintSecret, candidate.email.trim().toLowerCase())
    : null;
  const status = result.sent ? 'sent' : 'failed';
  const sentAt = result.sent ? new Date().toISOString() : null;
  db.prepare(`
    INSERT INTO vk_social_activity_email_reminders (
      reminder_key,
      application_id,
      showing_id,
      template,
      status,
      recipient_email_fingerprint,
      social_bonus_points,
      social_bonus_raw_points,
      last_activity_at,
      inactive_since_at,
      provider_message_id,
      error,
      sent_at,
      updated_at
    ) VALUES (
      @reminderKey,
      @applicationId,
      @showingId,
      @template,
      @status,
      @emailFingerprint,
      @socialBonusPoints,
      @socialBonusRawPoints,
      @lastActivityAt,
      @inactiveSinceAt,
      @providerMessageId,
      @error,
      @sentAt,
      @updatedAt
    )
    ON CONFLICT(reminder_key) DO UPDATE SET
      status = excluded.status,
      social_bonus_points = excluded.social_bonus_points,
      social_bonus_raw_points = excluded.social_bonus_raw_points,
      last_activity_at = excluded.last_activity_at,
      inactive_since_at = excluded.inactive_since_at,
      provider_message_id = excluded.provider_message_id,
      error = excluded.error,
      sent_at = excluded.sent_at,
      updated_at = excluded.updated_at
  `).run({
    reminderKey: candidate.reminderKey,
    applicationId: candidate.applicationId,
    showingId: candidate.showing.id,
    template: SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE,
    status,
    emailFingerprint,
    socialBonusPoints: candidate.social.bonusPoints,
    socialBonusRawPoints: candidate.social.rawPoints,
    lastActivityAt: candidate.social.latestActivityAt,
    inactiveSinceAt: candidate.social.inactiveSinceAt,
    providerMessageId: result.messageId,
    error: result.sent ? null : result.reason ?? null,
    sentAt,
    updatedAt: new Date().toISOString(),
  });
}

export async function sendSpecialSocialActivityReminders(
  db: Database.Database,
  options: SendSpecialSocialActivityRemindersOptions,
) {
  const dryRun = options.dryRun ?? true;
  const candidates = listSpecialSocialActivityReminderCandidates(db, options);
  const items: SendSpecialSocialActivityReminderItem[] = [];

  if (dryRun) {
    return {
      dryRun,
      candidateCount: candidates.length,
      sentCount: 0,
      failedCount: 0,
      items: candidates.map((candidate) => ({
        applicationId: candidate.applicationId,
        applicationCode: candidate.applicationCode,
        emailDomain: emailDomain(candidate.email),
        eventTitle: candidate.event.title,
        showingLabel: candidate.showing.displayLabel,
        socialBonusPoints: candidate.social.bonusPoints,
        latestActivityAt: candidate.social.latestActivityAt,
        sent: false,
        messageId: null,
        reason: 'dry_run',
      })),
    };
  }

  for (const candidate of candidates) {
    let result: EmailSendResult;
    try {
      result = await options.emailNotifications.sendSpecialSocialActivityReminder({
        applicationCode: candidate.applicationCode,
        fullName: candidate.fullName,
        email: candidate.email,
        event: candidate.event,
        showing: candidate.showing,
        social: {
          bonusPoints: candidate.social.bonusPoints,
          latestActivityAt: candidate.social.latestActivityAt,
          inactiveDays: candidate.social.inactiveDays,
        },
      });
    } catch (error) {
      result = buildFailureResult(error);
    }

    recordEmailNotification(db, {
      entityType: 'special_application',
      entityId: candidate.applicationId,
      template: SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE,
      recipientEmail: candidate.email,
      subject: result.subject ?? `Соцбаллы к розыгрышу: ${candidate.event.title}`,
      configurationSetName: options.postboxConfigurationSetName,
      fingerprintSecret: options.fingerprintSecret,
      result,
    });
    recordReminderLedger(db, candidate, options.fingerprintSecret, result);
    items.push({
      applicationId: candidate.applicationId,
      applicationCode: candidate.applicationCode,
      emailDomain: emailDomain(candidate.email),
      eventTitle: candidate.event.title,
      showingLabel: candidate.showing.displayLabel,
      socialBonusPoints: candidate.social.bonusPoints,
      latestActivityAt: candidate.social.latestActivityAt,
      sent: result.sent,
      messageId: result.messageId,
      reason: result.reason ?? null,
    });
  }

  return {
    dryRun,
    candidateCount: candidates.length,
    sentCount: items.filter((item) => item.sent).length,
    failedCount: items.filter((item) => !item.sent).length,
    items,
  };
}
