import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { listPublicEventStates, syncCatalog } from './catalog';

test('Skrebtsova lecture adds 25 percentage points to the future-event overbooking quota', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  syncCatalog(db);

  const event = db.prepare(`
    SELECT capacity, overbooking_percent, registration_limit
    FROM events
    WHERE slug = ?
  `).get(
    'istoriya-obrazovaniya-i-razvitiya-natsionalnogo-parka-kurshskaya-kosa',
  ) as {
    capacity: number;
    overbooking_percent: number;
    registration_limit: number;
  };

  assert.deepEqual(event, {
    capacity: 80,
    overbooking_percent: 108,
    registration_limit: 166,
  });

  db.close();
});

test('link-only presentation keeps its preliminary schedule private and registers up to 120 people', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  syncCatalog(db);

  const event = db.prepare(`
    SELECT
      starts_at,
      venue_name,
      address,
      capacity,
      overbooking_percent,
      registration_limit,
      registration_public_state
    FROM events
    WHERE slug = ?
  `).get('stendap-prezentatsiya-sayta-anonsov-sobytiy') as {
    starts_at: string;
    venue_name: string;
    address: string;
    capacity: number;
    overbooking_percent: number;
    registration_limit: number;
    registration_public_state: string;
  };

  assert.match(event.starts_at, /^2026-07-30T/);
  assert.equal(event.venue_name, 'ИЦАЭ, КГТУ');
  assert.equal(event.address, 'Советский проспект, 1');
  assert.equal(event.capacity, 120);
  assert.equal(event.overbooking_percent, 0);
  assert.equal(event.registration_limit, 120);
  assert.equal(event.registration_public_state, 'open');

  const publicEvent = listPublicEventStates(db, ['stendap-prezentatsiya-sayta-anonsov-sobytiy'])[0];
  assert.equal(publicEvent.publicState, 'registration_open');
  assert.equal(publicEvent.publicDetailsDeferred, true);
  assert.equal(publicEvent.startsAt, '');
  assert.equal(publicEvent.endsAt, '');
  assert.equal(publicEvent.venueName, '');
  assert.equal(publicEvent.hallName, '');
  assert.equal(publicEvent.address, '');
  assert.equal(publicEvent.registrationLimit, 120);

  db.close();
});
