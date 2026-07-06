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

function createDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertSpecialCandidate(db: Database.Database, publicKeyPemBase64: string, showingId: number) {
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: 'Анна Социальная',
    email: 'anna@example.com',
    phone: '+79001234567',
  });
  const info = db.prepare(`
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
      'SP-SOCIAL-1',
      (SELECT special_event_id FROM special_event_showings WHERE id = ?),
      ?, ?, ?, ?,
      'anna-social', 'anna@example.com', '+79001234567',
      ?,
      'accepted',
      5, 5, 5,
      5, 0, 0,
      10,
      'test',
      '{}',
      'test',
      'test',
      '2026-07-01T00:00:00.000Z'
    )
  `).run(
    showingId,
    encrypted.piiCiphertext,
    encrypted.piiWrappedKey,
    encrypted.piiIv,
    encrypted.piiAlg,
    JSON.stringify([showingId]),
  );
  const applicationId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)').run(applicationId, showingId);
  return applicationId;
}

test('special draw uses base score plus VK social bonus as effective raffle score', () => {
  const { publicKeyPemBase64, privateKeyPemBase64 } = keyPair();
  const db = createDb();
  const eventId = Number(db.prepare(`
    INSERT INTO special_events(
      slug, title, format_label, venue_name, preview_token, public_state,
      min_stamp_count, base_points, extra_stamp_points, no_show_grace_count,
      no_show_penalty_points, previous_winner_weight_percent
    ) VALUES (
      'social-draw-test', 'Тест соцбаллов', 'экскурсия', 'Тестовая площадка',
      'social-draw-test-token', 'open', 5, 10, 2, 3, 3, 100
    )
  `).run().lastInsertRowid);
  const showingId = Number(db.prepare(`
    INSERT INTO special_event_showings(
      special_event_id, slug, starts_at, display_label, time_is_final,
      physical_quota, reserved_seats, lottery_quota
    ) VALUES (?, '2026-08-01-1200', '2026-08-01T12:00:00+02:00', '1 августа 12:00', 1, 10, 0, 1)
  `).run(eventId).lastInsertRowid);
  const applicationId = insertSpecialCandidate(db, publicKeyPemBase64, showingId);

  db.prepare(`
    INSERT INTO vk_social_actors(
      vk_user_id, display_name, action_summary_json, activity_count, last_seen_at,
      match_status, match_method, match_confidence, matched_special_application_id,
      match_checked_at, created_at, updated_at
    ) VALUES (101, 'Анна Социальная', '[]', 6, '2026-07-03T00:00:00.000Z',
      'matched', 'deterministic', 0.99, ?, '2026-07-03T00:00:00.000Z',
      '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')
  `).run(applicationId);
  const insertActivity = db.prepare(`
    INSERT INTO vk_social_activities(activity_key, source, action, vk_user_id, group_id, post_id, activity_date, payload_json, created_at)
    VALUES (?, 'test', ?, 101, 1, ?, ?, '{}', ?)
  `);
  insertActivity.run('a1', 'repost_post', 1, '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z');
  insertActivity.run('a2', 'comment_post', 1, '2026-07-01T10:05:00.000Z', '2026-07-01T10:05:00.000Z');
  insertActivity.run('a3', 'comment_post', 1, '2026-07-01T10:06:00.000Z', '2026-07-01T10:06:00.000Z');
  insertActivity.run('a4', 'repost_post', 2, '2026-07-02T10:00:00.000Z', '2026-07-02T10:00:00.000Z');
  insertActivity.run('a5', 'comment_post', 2, '2026-07-02T10:05:00.000Z', '2026-07-02T10:05:00.000Z');
  insertActivity.run('a6', 'comment_post', 2, '2026-07-02T10:06:00.000Z', '2026-07-02T10:06:00.000Z');

  const result = runSpecialDraw(db, showingId, 'draft', privateKeyPemBase64);

  assert.equal(result.totalCandidates, 1);
  assert.equal(result.totalWeight, 12);
  assert.equal(result.candidates[0].baseScore, 10);
  assert.equal(result.candidates[0].socialBonusPoints, 2);
  assert.equal(result.candidates[0].score, 12);
  assert.equal(result.winners[0].drawWeight, 12);
  assert.equal(result.drawMechanism.audit[0].ticketRanges[0].baseScore, 10);
  assert.equal(result.drawMechanism.audit[0].ticketRanges[0].socialBonusPoints, 2);
});
