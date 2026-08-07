import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  claimTelegramUpdate,
  getTelegramUpdateId,
  isStaleTelegramMessageUpdate,
} from './telegram-update-guard';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE telegram_update_claims (
      update_id INTEGER PRIMARY KEY,
      claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  return db;
}

test('a Telegram update id can be claimed only once', () => {
  const db = createDb();
  try {
    assert.equal(claimTelegramUpdate(db, 123456), true);
    assert.equal(claimTelegramUpdate(db, 123456), false);
    assert.equal(claimTelegramUpdate(db, 123457), true);
  } finally {
    db.close();
  }
});

test('invalid Telegram update ids are rejected', () => {
  assert.equal(getTelegramUpdateId({ update_id: 42 }), 42);
  assert.equal(getTelegramUpdateId({ update_id: -1 }), null);
  assert.equal(getTelegramUpdateId({ update_id: 1.5 }), null);
  assert.equal(getTelegramUpdateId({ update_id: '42' }), null);
  assert.equal(getTelegramUpdateId({}), null);
});

test('old message updates are stale while fresh and callback-only updates remain processable', () => {
  const now = 2_000_000_000;
  assert.equal(
    isStaleTelegramMessageUpdate({ update_id: 1, message: { date: now - 601 } }, 300, now),
    true,
  );
  assert.equal(
    isStaleTelegramMessageUpdate({ update_id: 2, message: { date: now - 299 } }, 300, now),
    false,
  );
  assert.equal(
    isStaleTelegramMessageUpdate({ update_id: 3 }, 300, now),
    false,
  );
});
