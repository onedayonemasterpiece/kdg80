import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import type { EmailNotificationService } from './email-notifications';
import {
  SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE,
  listSpecialSocialActivityReminderCandidates,
  sendSpecialSocialActivityReminders,
} from './special-social-reminders';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKeyPemBase64: Buffer.from(publicKey).toString('base64'),
    privateKeyPemBase64: Buffer.from(privateKey).toString('base64'),
  };
}

function createDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedCandidate(db: Database.Database, publicKeyPemBase64: string) {
  const eventId = Number(db.prepare(`
    INSERT INTO special_events(
      slug, title, format_label, venue_name, preview_token, public_state,
      min_stamp_count, base_points, extra_stamp_points, no_show_grace_count,
      no_show_penalty_points, previous_winner_weight_percent
    ) VALUES (
      'reminder-test', 'Экскурсия с соцбаллами', 'экскурсия', 'Площадка',
      'reminder-test-token', 'open', 5, 10, 2, 3, 3, 100
    )
  `).run().lastInsertRowid);
  const showingId = Number(db.prepare(`
    INSERT INTO special_event_showings(
      special_event_id, slug, starts_at, display_label, time_is_final,
      physical_quota, reserved_seats, lottery_quota
    ) VALUES (?, '2026-08-10-1200', '2026-08-10T12:00:00+02:00', '10 августа 12:00', 1, 10, 0, 1)
  `).run(eventId).lastInsertRowid);
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: 'Ирина Напоминание',
    email: 'irina@example.com',
    phone: '+79007654321',
  });
  const applicationId = Number(db.prepare(`
    INSERT INTO special_applications (
      application_code,
      special_event_id,
      pii_ciphertext,
      pii_wrapped_key,
      pii_iv,
      pii_alg,
      full_name_fingerprint,
      email_fingerprint,
      phone_fingerprint,
      selected_showing_ids_json,
      status,
      uploaded_photo_count,
      unique_photo_count,
      accepted_photo_count,
      stamp_count,
      ordinary_registration_count,
      no_show_count,
      score,
      ocr_provider,
      ocr_summary_json,
      consent_version,
      consent_text_hash,
      consent_accepted_at
    ) VALUES (
      'SP-REMIND-1', ?, ?, ?, ?, ?,
      'irina-reminder', 'irina@example.com', '+79007654321',
      ?, 'accepted', 5, 5, 5, 5, 0, 0, 10,
      'test', '{}', 'test', 'test', '2026-07-01T00:00:00.000Z'
    )
  `).run(
    eventId,
    encrypted.piiCiphertext,
    encrypted.piiWrappedKey,
    encrypted.piiIv,
    encrypted.piiAlg,
    JSON.stringify([showingId]),
  ).lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)').run(applicationId, showingId);
  return { applicationId, showingId };
}

function insertMatchedActorWithActivity(
  db: Database.Database,
  applicationId: number,
  activityAt: string,
) {
  db.prepare(`
    INSERT INTO vk_social_actors(
      vk_user_id, display_name, action_summary_json, activity_count, last_seen_at,
      match_status, match_method, match_confidence, matched_special_application_id,
      match_checked_at, created_at, updated_at
    ) VALUES (201, 'Ирина Напоминание', '[]', 1, ?,
      'matched', 'deterministic', 0.99, ?, ?, ?, ?)
  `).run(activityAt, applicationId, activityAt, activityAt, activityAt);
  db.prepare(`
    INSERT INTO vk_social_activities(activity_key, source, action, vk_user_id, group_id, post_id, activity_date, payload_json, created_at)
    VALUES ('recent-1', 'test', 'like_post', 201, 1, 1, ?, '{}', ?)
  `).run(activityAt, activityAt);
}

test('accepted applicant with future draw and no recent VK activity is selected for reminder', () => {
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const db = createDb();
  const { applicationId } = seedCandidate(db, publicKeyPemBase64);

  const candidates = listSpecialSocialActivityReminderCandidates(db, {
    privateKeyPemBase64,
    now: new Date('2026-07-06T12:00:00.000Z'),
    inactiveDays: 5,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].applicationId, applicationId);
  assert.equal(candidates[0].event.title, 'Экскурсия с соцбаллами');
  assert.equal(candidates[0].social.latestActivityAt, null);
});

test('recent matched VK activity suppresses reminder', () => {
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const db = createDb();
  const { applicationId } = seedCandidate(db, publicKeyPemBase64);
  insertMatchedActorWithActivity(db, applicationId, '2026-07-04T12:00:00.000Z');

  const candidates = listSpecialSocialActivityReminderCandidates(db, {
    privateKeyPemBase64,
    now: new Date('2026-07-06T12:00:00.000Z'),
    inactiveDays: 5,
  });

  assert.equal(candidates.length, 0);
});

test('send path records email notification and reminder ledger', async () => {
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const db = createDb();
  const { applicationId, showingId } = seedCandidate(db, publicKeyPemBase64);
  const fakeEmail: EmailNotificationService = {
    async sendRegistrationCreated() {
      throw new Error('not used');
    },
    async sendSpecialApplicationCreated() {
      throw new Error('not used');
    },
    async sendSpecialWinner() {
      throw new Error('not used');
    },
    async sendSpecialSocialActivityReminder(input) {
      return {
        sent: true,
        provider: 'yandex-postbox',
        messageId: 'test-message-id',
        subject: `Соцбаллы к розыгрышу: ${input.event.title}`,
      };
    },
  };

  const summary = await sendSpecialSocialActivityReminders(db, {
    emailNotifications: fakeEmail,
    privateKeyPemBase64,
    fingerprintSecret: 'test-secret',
    postboxConfigurationSetName: 'test-set',
    dryRun: false,
    now: new Date('2026-07-06T12:00:00.000Z'),
    inactiveDays: 5,
  });

  assert.equal(summary.sentCount, 1);
  const notification = db.prepare(`
    SELECT template, provider_message_id
    FROM email_notifications
    WHERE entity_type = 'special_application' AND entity_id = ?
  `).get(applicationId) as { template: string; provider_message_id: string };
  assert.equal(notification.template, SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE);
  assert.equal(notification.provider_message_id, 'test-message-id');
  const reminder = db.prepare(`
    SELECT reminder_key, status
    FROM vk_social_activity_email_reminders
    WHERE application_id = ? AND showing_id = ?
  `).get(applicationId, showingId) as { reminder_key: string; status: string };
  assert.equal(reminder.reminder_key, `${SPECIAL_SOCIAL_ACTIVITY_REMINDER_TEMPLATE}:${applicationId}:${showingId}`);
  assert.equal(reminder.status, 'sent');
});
