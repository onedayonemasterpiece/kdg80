import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { syncCatalog } from './catalog';

test('Skrebtsova lecture adds 15 percentage points to the future-event overbooking quota', () => {
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
    overbooking_percent: 98,
    registration_limit: 158,
  });

  db.close();
});
