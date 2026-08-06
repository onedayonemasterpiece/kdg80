import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import { runSpecialDraw } from './special-draws';

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

test('an accepted TEST application is excluded from the production draw pool', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();

  try {
    const eventId = Number(db.prepare(`
      SELECT id
      FROM special_events
      WHERE slug = 'amber-combine-jewelry-excursion'
    `).pluck().get());
    const showingId = Number(db.prepare(`
      SELECT id
      FROM special_event_showings
      WHERE slug = '2026-08-11-1100'
    `).pluck().get());
    const encrypted = encryptPii(publicKeyPemBase64, {
      fullName: 'ТЕСТ Янтарный Комбинат 01',
      email: 'amber-test-draw@example.com',
      phone: '+79990000001',
    });

    const profileId = Number(db.prepare(`
      INSERT INTO special_participant_profiles(
        full_name_fingerprint,
        email_fingerprint,
        phone_fingerprint,
        latest_stamp_count
      ) VALUES ('test-draw-name', 'test-draw-email', 'test-draw-phone', 6)
    `).run().lastInsertRowid);

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
        'TEST-SP-DRAW-EXCLUSION',
        ?, ?, ?, ?, ?, ?,
        'test-draw-name', 'test-draw-email', 'test-draw-phone', ?,
        'accepted', 1, 1, 1, 6, 0, 0, 12,
        'test', '{}', 'test', 'test', '2026-08-06T00:00:00.000Z'
      )
    `).run(
      eventId,
      profileId,
      encrypted.piiCiphertext,
      encrypted.piiWrappedKey,
      encrypted.piiIv,
      encrypted.piiAlg,
      JSON.stringify([showingId]),
    ).lastInsertRowid);

    db.prepare(`
      INSERT INTO special_application_showings(application_id, showing_id)
      VALUES (?, ?)
    `).run(applicationId, showingId);

    const result = runSpecialDraw(db, showingId, 'draft', privateKeyPemBase64);

    assert.equal(result.totalCandidates, 0);
    assert.equal(result.totalWeight, 0);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.winners, []);
  } finally {
    db.close();
  }
});
