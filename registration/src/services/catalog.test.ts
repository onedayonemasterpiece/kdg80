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

test('special-only presentation uses the history museum quota of 220 people', () => {
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
  assert.equal(event.venue_name, 'Калининградский областной историко-художественный музей');
  assert.equal(event.address, 'улица Клиническая, 21');
  assert.equal(event.capacity, 220);
  assert.equal(event.overbooking_percent, 0);
  assert.equal(event.registration_limit, 220);
  assert.equal(event.registration_public_state, 'open');

  const publicEvent = listPublicEventStates(db, ['stendap-prezentatsiya-sayta-anonsov-sobytiy'])[0];
  assert.equal(publicEvent.publicState, 'registration_open');
  assert.equal(publicEvent.publicDetailsDeferred, false);
  assert.match(publicEvent.startsAt, /^2026-07-30T/);
  assert.match(publicEvent.endsAt, /^2026-07-30T/);
  assert.equal(publicEvent.venueName, 'Калининградский областной историко-художественный музей');
  assert.equal(publicEvent.hallName, 'Конференц-зал');
  assert.equal(publicEvent.address, 'улица Клиническая, 21');
  assert.equal(publicEvent.registrationLimit, 220);

  db.close();
});
