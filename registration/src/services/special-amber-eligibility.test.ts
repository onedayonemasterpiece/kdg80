import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import {
  confirmSpecialApplicationRussianCitizenship,
  listSpecialShowingsDueForAutoDraw,
  runSpecialDraw,
} from './special-draws';

function keys() {
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

function insertCandidate(
  db: Database.Database,
  publicKeyPemBase64: string,
  showingId: number,
  code: string,
  email: string,
  citizenshipConfirmed: boolean,
) {
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: code.includes('PENDING') ? 'Елена Ожидающая' : 'Анна Подтвержденная',
    email,
    phone: code.includes('PENDING') ? '+79001111111' : '+79002222222',
  });
  const info = db.prepare(`
    INSERT INTO special_applications (
      application_code, special_event_id,
      pii_ciphertext, pii_wrapped_key, pii_iv, pii_alg,
      full_name_fingerprint, email_fingerprint, phone_fingerprint,
      selected_showing_ids_json, russian_citizenship_confirmed,
      status, uploaded_photo_count, unique_photo_count, accepted_photo_count,
      stamp_count, ordinary_registration_count, no_show_count, score,
      ocr_provider, ocr_summary_json,
      consent_version, consent_text_hash, consent_accepted_at
    ) VALUES (
      ?, (SELECT special_event_id FROM special_event_showings WHERE id = ?),
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      'accepted', 1, 1, 1, 5, 0, 0, 10,
      'test', '{}', 'test', 'test', '2026-08-01T00:00:00.000Z'
    )
  `).run(
    code,
    showingId,
    encrypted.piiCiphertext,
    encrypted.piiWrappedKey,
    encrypted.piiIv,
    encrypted.piiAlg,
    `${code}-name`,
    email,
    `${code}-phone`,
    JSON.stringify([showingId]),
    citizenshipConfirmed ? 1 : 0,
  );
  const applicationId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)')
    .run(applicationId, showingId);
  return applicationId;
}

test('amber draw starts exactly 48 hours before the excursion and excludes unconfirmed citizenship', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { publicKeyPemBase64, privateKeyPemBase64 } = keys();
  const showing = db.prepare(`
    SELECT id
    FROM special_event_showings
    WHERE slug = '2026-08-11-1100'
  `).get() as { id: number };

  assert.equal(
    listSpecialShowingsDueForAutoDraw(db, new Date('2026-08-09T08:59:59.000Z'))
      .some((item) => item.showing.id === showing.id),
    false,
  );
  const due = listSpecialShowingsDueForAutoDraw(db, new Date('2026-08-09T09:00:00.000Z'))
    .find((item) => item.showing.id === showing.id);
  assert.ok(due);
  assert.equal(due.autoPublishAt, '2026-08-09T09:00:00.000Z');
  assert.equal(due.event.auto_draw_lead_hours, 48);

  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-CONFIRMED', 'confirmed@example.com', true);
  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-PENDING', 'pending@example.com', false);

  const firstDraw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(firstDraw.totalCandidates, 1);
  assert.equal(firstDraw.candidates[0].applicationCode, 'AMBER-CONFIRMED');

  const confirmed = confirmSpecialApplicationRussianCitizenship(db, 'AMBER-PENDING');
  assert.equal(confirmed?.application_code, 'AMBER-PENDING');

  const secondDraw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(secondDraw.totalCandidates, 2);
  assert.deepEqual(
    new Set(secondDraw.candidates.map((candidate) => candidate.applicationCode)),
    new Set(['AMBER-CONFIRMED', 'AMBER-PENDING']),
  );
});
