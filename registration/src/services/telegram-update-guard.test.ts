import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  claimTelegramUpdate,
  getTelegramUpdateId,
  isFullExportUpdate,
  isStaleFullExportUpdate,
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

test('an export update id can be claimed only once', () => {
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

test('only the full-export command and callback use the protected path', () => {
  assert.equal(isFullExportUpdate({ message: { text: '/export_all' } }), true);
  assert.equal(isFullExportUpdate({ message: { text: '/export_all@kgd80bot' } }), true);
  assert.equal(isFullExportUpdate({ callback_query: { data: 'exp:all' } }), true);
  assert.equal(isFullExportUpdate({ message: { text: '/export_all_extra' } }), false);
  assert.equal(isFullExportUpdate({ message: { text: '/health' } }), false);
  assert.equal(isFullExportUpdate({ callback_query: { data: 'exp:backup' } }), false);
});

test('only an old message-based full export is stale', () => {
  const now = 2_000_000_000;
  assert.equal(
    isStaleFullExportUpdate({
      update_id: 1,
      message: { text: '/export_all', date: now - 601 },
    }, 300, now),
    true,
  );
  assert.equal(
    isStaleFullExportUpdate({
      update_id: 2,
      message: { text: '/export_all', date: now - 299 },
    }, 300, now),
    false,
  );
  assert.equal(
    isStaleFullExportUpdate({
      update_id: 3,
      message: { text: '/health', date: now - 601 },
    }, 300, now),
    false,
  );
  assert.equal(
    isStaleFullExportUpdate({
      update_id: 4,
      callback_query: { data: 'exp:all' },
    }, 300, now),
    false,
  );
});
