import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import { createStoragePublisher } from '../lib/storage';
import {
  cleanupSpecialTestApplication,
  createSpecialTestCleanupToken,
  SpecialTestCleanupError,
  verifySpecialTestCleanupToken,
} from './special-test-cleanup';

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

function insertApplication(
  db: Database.Database,
  publicKeyPemBase64: string,
  options: { code: string; fullName: string; suffix: string },
) {
  const eventId = Number(db.prepare(`
    SELECT id FROM special_events WHERE slug = 'amber-combine-jewelry-excursion'
  `).pluck().get());
  const showingId = Number(db.prepare(`
    SELECT id FROM special_event_showings WHERE slug = '2026-08-11-1100'
  `).pluck().get());
  const profileId = Number(db.prepare(`
    INSERT INTO special_participant_profiles(
      full_name_fingerprint, email_fingerprint, phone_fingerprint, latest_stamp_count
    ) VALUES (?, ?, ?, 6)
  `).run(`name-${options.suffix}`, `email-${options.suffix}`, `phone-${options.suffix}`).lastInsertRowid);
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: options.fullName,
    email: `${options.suffix}@example.com`,
    phone: '+79001234567',
  });
  const applicationId = Number(db.prepare(`
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
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'accepted', 2, 2, 2, 6, 0, 0, 12,
      'test', '{}', 'test', 'test', '2026-08-06T00:00:00.000Z'
    )
  `).run(
    options.code,
    eventId,
    profileId,
    encrypted.piiCiphertext,
    encrypted.piiWrappedKey,
    encrypted.piiIv,
    encrypted.piiAlg,
    `name-${options.suffix}`,
    `email-${options.suffix}`,
    `phone-${options.suffix}`,
    JSON.stringify([showingId]),
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)
  `).run(applicationId, showingId);
  return { applicationId, profileId };
}

test('cleanup token is deterministic and rejects altered values', () => {
  const secret = 'test-fingerprint-secret';
  const code = 'TEST-SP-CLEANUP';
  const token = createSpecialTestCleanupToken(secret, code);
  assert.equal(verifySpecialTestCleanupToken(secret, code, token), true);
  assert.equal(verifySpecialTestCleanupToken(secret, code, `${token}x`), false);
  assert.equal(verifySpecialTestCleanupToken(secret, `${code}-other`, token), false);
});

test('special TEST application cleanup removes DB rows and private photos', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kgd80-special-test-cleanup-'));
  const storagePublisher = createStoragePublisher({
    driver: 'local',
    publicTicketBaseUrl: 'https://kgd80.ru',
    ticketsPrefix: 'tickets',
    localPublicRoot: root,
    s3Bucket: null,
    s3Endpoint: null,
    s3Region: null,
    s3AccessKeyId: null,
    s3SecretAccessKey: null,
    s3ForcePathStyle: true,
  });
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const code = 'TEST-SP-CLEANUP-1';

  try {
    const { applicationId, profileId } = insertApplication(db, publicKeyPemBase64, {
      code,
      fullName: 'ТЕСТ Янтарный Комбинат',
      suffix: 'cleanup1',
    });
    const keys = [
      `exports/special-passports/amber-combine-jewelry-excursion/${code}/01-a.jpg`,
      `exports/special-passports/amber-combine-jewelry-excursion/${code}/02-b.jpg`,
    ];
    for (const [index, key] of keys.entries()) {
      await storagePublisher.publishPrivateAsset({
        key,
        body: Buffer.from(`photo-${index}`),
        contentType: 'image/jpeg',
      });
      db.prepare(`
        INSERT INTO special_application_photos(
          application_id, storage_key, original_filename, content_type,
          size_bytes, sha256, has_full_name, stamp_count, accepted, confidence, ocr_json
        ) VALUES (?, ?, ?, 'image/jpeg', 7, ?, 1, 3, 1, 0.99, '{}')
      `).run(applicationId, key, `photo-${index}.jpg`, `sha-${index}`);
    }
    db.prepare(`
      INSERT INTO telegram_outbox(type, payload_json)
      VALUES ('special_application_created', ?)
    `).run(JSON.stringify({ applicationId }));
    const notificationId = Number(db.prepare(`
      INSERT INTO email_notifications(
        entity_type, entity_id, template, provider, subject, status
      ) VALUES ('special_application', ?, 'special_application_created', 'yandex-postbox', 'test', 'send_failed')
    `).run(applicationId).lastInsertRowid);
    db.prepare(`
      INSERT INTO email_notification_events(
        notification_id, provider, provider_event_id, event_type, event_at
      ) VALUES (?, 'yandex-postbox', 'evt-test-cleanup', 'send_failed', '2026-08-06T00:00:01.000Z')
    `).run(notificationId);

    const result = await cleanupSpecialTestApplication(db, {
      applicationCode: code,
      privateKeyPemBase64,
      storagePublisher,
    });

    assert.ok(result);
    assert.equal(result.removedApplication, 1);
    assert.equal(result.removedProfile, 1);
    assert.equal(result.removedPrivateAssets, 2);
    assert.equal(result.removedTelegramOutboxRows, 1);
    assert.equal(result.removedEmailNotifications, 1);
    assert.equal(result.removedEmailEvents, 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM special_applications WHERE id = ?').pluck().get(applicationId), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM special_participant_profiles WHERE id = ?').pluck().get(profileId), 0);
    for (const key of keys) {
      assert.equal(fs.existsSync(path.join(root, key)), false);
    }
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup refuses an application whose decrypted name is not prefixed TEST', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kgd80-special-test-guard-'));
  const storagePublisher = createStoragePublisher({
    driver: 'local',
    publicTicketBaseUrl: 'https://kgd80.ru',
    ticketsPrefix: 'tickets',
    localPublicRoot: root,
    s3Bucket: null,
    s3Endpoint: null,
    s3Region: null,
    s3AccessKeyId: null,
    s3SecretAccessKey: null,
    s3ForcePathStyle: true,
  });
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const code = 'SP-NOT-TEST';

  try {
    const { applicationId } = insertApplication(db, publicKeyPemBase64, {
      code,
      fullName: 'Иван Иванов',
      suffix: 'guard1',
    });
    await assert.rejects(
      () => cleanupSpecialTestApplication(db, {
        applicationCode: code,
        privateKeyPemBase64,
        storagePublisher,
      }),
      (error: unknown) => (
        error instanceof SpecialTestCleanupError
        && error.statusCode === 403
        && error.code === 'not_a_test_application'
      ),
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM special_applications WHERE id = ?').pluck().get(applicationId), 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
