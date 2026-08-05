import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { getSpecialEventPreview } from './special-applications';

function createDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

test('amber combine public event hides all numeric quota fields', () => {
  const db = createDb();
  try {
    const preview = getSpecialEventPreview(
      db,
      'amber-combine-jewelry-excursion',
      'amber-combine-jewelry-20260811',
    ) as Record<string, any> | null;

    assert.ok(preview);
    assert.equal(preview.quotaVisibility, 'hidden');
    assert.equal(preview.showings.length, 1);

    const showing = preview.showings[0] as Record<string, unknown>;
    assert.equal(showing.quotaVisibility, 'hidden');
    assert.equal(showing.slug, '2026-08-11-1100');
    assert.equal(showing.displayLabel, '11 августа 11:00 · ювелирное производство Янтарного комбината');
    assert.equal(showing.applicationAvailable, true);
    assert.equal('physicalQuota' in showing, false);
    assert.equal('reservedSeats' in showing, false);
    assert.equal('lotteryQuota' in showing, false);
  } finally {
    db.close();
  }
});

test('existing public special events retain visible quota fields', () => {
  const db = createDb();
  try {
    const preview = getSpecialEventPreview(
      db,
      'yantar-excursion',
      'yantar-excursion-20260716',
    ) as Record<string, any> | null;

    assert.ok(preview);
    assert.equal(preview.quotaVisibility, 'visible');
    assert.ok(preview.showings.length >= 1);

    const showing = preview.showings[0] as Record<string, unknown>;
    assert.equal(showing.quotaVisibility, 'visible');
    assert.equal(typeof showing.physicalQuota, 'number');
    assert.equal(typeof showing.reservedSeats, 'number');
    assert.equal(typeof showing.lotteryQuota, 'number');
  } finally {
    db.close();
  }
});
