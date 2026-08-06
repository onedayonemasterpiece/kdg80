import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { computeFingerprint, encryptPii } from '../src/lib/crypto.js';
import { createEmailNotificationService } from '../src/services/email-notifications.js';
import { recordEmailNotification } from '../src/services/email-stats.js';

const EVENT_SLUG = 'amber-combine-jewelry-excursion';
const SHOWING_SLUG = '2026-08-11-1100';
const target = process.env.AMBER_TEST_EMAIL?.trim() || 'info@kgd80.ru';
const config = loadConfig();

if (!config.piiPublicKeyPemBase64 || !config.piiFingerprintSecret) {
  throw new Error('PII_PUBLIC_KEY_PEM_B64 and PII_FINGERPRINT_SECRET are required.');
}

const db = createDatabase(config.sqlitePath);
runMigrations(db);

const event = db.prepare(`
  SELECT id, slug, title, venue_name
  FROM special_events
  WHERE slug = ?
  LIMIT 1
`).get(EVENT_SLUG) as { id: number; slug: string; title: string; venue_name: string } | undefined;
if (!event) {
  throw new Error('Amber special event is missing.');
}

const showing = db.prepare(`
  SELECT id, slug, display_label, starts_at
  FROM special_event_showings
  WHERE special_event_id = ? AND slug = ?
  LIMIT 1
`).get(event.id, SHOWING_SLUG) as { id: number; slug: string; display_label: string; starts_at: string } | undefined;
if (!showing) {
  throw new Error('Amber showing is missing.');
}

const now = new Date();
const timestamp = now.toISOString().replace(/\D/gu, '').slice(0, 14);
const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();
const applicationCode = `TEST-AMBER-MAIL-${timestamp}-${nonce}`;
const fullName = `TEST Проверка Почты ${timestamp.slice(-6)}`;
const phone = `+7900${String(Date.now()).slice(-7)}`;
const normalizedEmail = target.toLowerCase();
const fullNameFingerprint = computeFingerprint(config.piiFingerprintSecret, fullName.toLowerCase());
const emailFingerprint = computeFingerprint(config.piiFingerprintSecret, normalizedEmail);
const phoneFingerprint = computeFingerprint(config.piiFingerprintSecret, phone);

const nonTestConflict = db.prepare(`
  SELECT application_code
  FROM special_applications
  WHERE special_event_id = ?
    AND email_fingerprint = ?
    AND status = 'accepted'
    AND application_code NOT LIKE 'TEST-%'
  LIMIT 1
`).get(event.id, emailFingerprint) as { application_code: string } | undefined;
if (nonTestConflict) {
  throw new Error(`A real accepted application already uses ${target}: ${nonTestConflict.application_code}`);
}

db.prepare(`
  UPDATE special_applications
  SET status = 'rejected',
      rejection_reason = 'Предыдущая служебная проверка почтового уведомления заменена новой.'
  WHERE special_event_id = ?
    AND email_fingerprint = ?
    AND status = 'accepted'
    AND application_code LIKE 'TEST-%'
`).run(event.id, emailFingerprint);

const encrypted = encryptPii(config.piiPublicKeyPemBase64, {
  fullName,
  email: target,
  phone,
  vkUserId: '',
  vkFirstName: '',
  vkLastName: '',
  vkEmail: '',
  vkPhone: '',
});

const applicationId = db.transaction(() => {
  const profile = db.prepare(`
    INSERT INTO special_participant_profiles(
      full_name_fingerprint,
      email_fingerprint,
      phone_fingerprint,
      latest_stamp_count,
      latest_checked_at
    ) VALUES (?, ?, ?, 5, ?)
    ON CONFLICT(full_name_fingerprint, email_fingerprint, phone_fingerprint)
    DO UPDATE SET
      latest_stamp_count = 5,
      latest_checked_at = excluded.latest_checked_at,
      updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    RETURNING id
  `).get(fullNameFingerprint, emailFingerprint, phoneFingerprint, now.toISOString()) as { id: number };

  const application = db.prepare(`
    INSERT INTO special_applications(
      application_code,
      special_event_id,
      participant_profile_id,
      pii_ciphertext,
      pii_wrapped_key,
      pii_iv,
      pii_alg,
      full_name_fingerprint,
      email_fingerprint,
      phone_fingerprint,
      vk_auth_provider,
      vk_user_id_fingerprint,
      vk_auth_verified_at,
      vk_auth_scope,
      selected_showing_ids_json,
      russian_citizenship_confirmed,
      status,
      rejection_reason,
      uploaded_photo_count,
      unique_photo_count,
      accepted_photo_count,
      stamp_count,
      ordinary_registration_count,
      no_show_count,
      volunteer_bonus_points,
      volunteer_match_json,
      score,
      ocr_provider,
      ocr_model,
      ocr_summary_json,
      consent_version,
      consent_text_hash,
      consent_accepted_at,
      source_ip,
      user_agent
    ) VALUES (
      @applicationCode,
      @specialEventId,
      @participantProfileId,
      @piiCiphertext,
      @piiWrappedKey,
      @piiIv,
      @piiAlg,
      @fullNameFingerprint,
      @emailFingerprint,
      @phoneFingerprint,
      NULL,
      NULL,
      NULL,
      NULL,
      @selectedShowingIdsJson,
      0,
      'accepted',
      NULL,
      1,
      1,
      1,
      5,
      0,
      0,
      0,
      @volunteerMatchJson,
      10,
      'manual-test-fixture',
      NULL,
      @ocrSummaryJson,
      @consentVersion,
      @consentTextHash,
      @consentAcceptedAt,
      '127.0.0.1',
      'amber-production-mail-verification'
    )
  `).run({
    applicationCode,
    specialEventId: event.id,
    participantProfileId: profile.id,
    ...encrypted,
    fullNameFingerprint,
    emailFingerprint,
    phoneFingerprint,
    selectedShowingIdsJson: JSON.stringify([showing.id]),
    volunteerMatchJson: JSON.stringify({ matched: false, bonusPoints: 0, matchType: 'none' }),
    ocrSummaryJson: JSON.stringify({
      testFixture: true,
      hasFullName: true,
      stampCount: 5,
      minStampCount: 5,
      acceptedPhotoCount: 1,
      uniquePhotoCount: 1,
    }),
    consentVersion: config.consentVersion,
    consentTextHash: config.consentTextHash,
    consentAcceptedAt: now.toISOString(),
  });

  const id = Number(application.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)')
    .run(id, showing.id);
  db.prepare(`
    INSERT INTO special_application_photos(
      application_id,
      storage_key,
      original_filename,
      content_type,
      size_bytes,
      sha256,
      duplicate_of_sha256,
      has_full_name,
      stamp_count,
      accepted,
      confidence,
      ocr_json
    ) VALUES (?, ?, 'test-fixture.jpg', 'image/jpeg', 0, ?, NULL, 1, 5, 1, 1, ?)
  `).run(
    id,
    `test-fixtures/${applicationCode}/passport.jpg`,
    crypto.createHash('sha256').update(applicationCode).digest('hex'),
    JSON.stringify({ testFixture: true, noFileStored: true }),
  );
  return id;
})();

const service = createEmailNotificationService({
  enabled: config.postboxEnabled,
  endpoint: config.postboxEndpoint,
  region: config.postboxRegion,
  accessKeyId: config.postboxAccessKeyId,
  secretAccessKey: config.postboxSecretAccessKey,
  fromEmail: config.postboxFromEmail,
  fromName: config.postboxFromName,
  replyToEmail: config.postboxReplyToEmail,
  configurationSetName: config.postboxConfigurationSetName,
  archiveBccEmail: config.postboxArchiveBccEmail,
  timeZone: config.timeZone,
  sendTimeoutMs: config.postboxSendTimeoutMs,
});

const result = await service.sendSpecialApplicationCreated({
  applicationCode,
  status: 'accepted',
  rejectionReason: null,
  event: {
    slug: event.slug,
    title: event.title,
    venueName: event.venue_name,
  },
  selectedShowings: [{
    slug: showing.slug,
    displayLabel: showing.display_label,
    startsAt: showing.starts_at,
  }],
  scoring: { stampCount: 5, score: 10 },
  fullName,
  email: target,
});

recordEmailNotification(db, {
  entityType: 'special_application',
  entityId: applicationId,
  template: 'special_application_created',
  recipientEmail: target,
  subject: result.subject || `Заявка на спецмероприятие: ${event.title}`,
  configurationSetName: config.postboxConfigurationSetName,
  fingerprintSecret: config.piiFingerprintSecret,
  result,
});

if (!result.sent) {
  throw new Error(`Test application email was not sent: ${result.reason || 'unknown reason'}`);
}

db.close();
console.log(JSON.stringify({
  applicationCode,
  applicationId,
  sent: result.sent,
  messageId: result.messageId,
  subject: result.subject,
  target,
  eventSlug: event.slug,
  showingSlug: showing.slug,
}));
