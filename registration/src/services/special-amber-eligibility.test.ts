import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import { listSpecialShowingsDueForAutoDraw, runSpecialDraw } from './special-draws';

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

function insertCandidate(db: Database.Database, publicKeyPemBase64: string, showingId: number, code: string, email: string) {
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: code.endsWith('ONE') ? 'Анна Первая' : 'Елена Вторая',
    email,
    phone: code.endsWith('ONE') ? '+79001111111' : '+79002222222',
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
      ?, ?, ?, ?, 0,
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
  );
  const applicationId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)')
    .run(applicationId, showingId);
}

test('amber draw starts 48 hours before the excursion and does not filter applicants by a citizenship checkbox', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { publicKeyPemBase64, privateKeyPemBase64 } = keys();
  const showing = db.prepare(`SELECT id FROM special_event_showings WHERE slug = '2026-08-11-1100'`)
    .get() as { id: number };
  const event = db.prepare(`SELECT requires_russian_citizenship FROM special_events WHERE slug = 'amber-combine-jewelry-excursion'`)
    .get() as { requires_russian_citizenship: number };

  assert.equal(event.requires_russian_citizenship, 0);
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

  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-ONE', 'one@example.com');
  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-TWO', 'two@example.com');
  const draw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(draw.totalCandidates, 2);
  assert.deepEqual(
    new Set(draw.candidates.map((candidate) => candidate.applicationCode)),
    new Set(['AMBER-ONE', 'AMBER-TWO']),
  );
});
