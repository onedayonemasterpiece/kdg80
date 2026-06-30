import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { computeSocialRaffleBonusFromActivities, loadSocialRaffleBonuses } from './special-social-scoring';

test('two strong social days are comparable with one additional visit', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:05:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:06:00.000Z' },
    { action: 'repost_post', occurredAt: '2026-06-21T10:00:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-21T10:05:00.000Z' },
    { action: 'reply_comment', occurredAt: '2026-06-21T10:06:00.000Z' },
  ]);

  assert.equal(result.rawPoints, 2.2);
  assert.equal(result.bonusPoints, 2);
  assert.equal(result.activeDays, 2);
});

test('likes alone need sustained activity across days to add points', () => {
  const singleDay = computeSocialRaffleBonusFromActivities(1, Array.from({ length: 20 }, (_, index) => ({
    action: 'like_post',
    occurredAt: `2026-06-20T10:${String(index).padStart(2, '0')}:00.000Z`,
  })));

  assert.equal(singleDay.rawPoints, 0.5);
  assert.equal(singleDay.bonusPoints, 0);

  const severalDays = computeSocialRaffleBonusFromActivities(1, [
    { action: 'like_post', occurredAt: '2026-06-19T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-19T10:01:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:01:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:02:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:03:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-23T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-23T10:01:00.000Z' },
  ]);

  assert.equal(severalDays.rawPoints, 1.1);
  assert.equal(severalDays.bonusPoints, 1);
});

test('production-like reposts and likes can fairly reach two social points', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'like_post', occurredAt: '2026-06-19T19:03:51.762Z' },
    { action: 'like_post', occurredAt: '2026-06-19T19:03:51.762Z' },
    { action: 'repost_post', occurredAt: '2026-06-20T07:41:19.000Z' },
    { action: 'repost_post', occurredAt: '2026-06-20T07:47:19.000Z' },
    { action: 'repost_post', occurredAt: '2026-06-20T07:47:25.000Z' },
    { action: 'like_post', occurredAt: '2026-06-20T19:02:54.672Z' },
    { action: 'repost_post', occurredAt: '2026-06-20T19:02:54.672Z' },
    { action: 'like_post', occurredAt: '2026-06-21T19:03:17.167Z' },
    { action: 'like_post', occurredAt: '2026-06-21T19:03:17.168Z' },
    { action: 'like_post', occurredAt: '2026-06-21T19:03:17.168Z' },
    { action: 'like_post', occurredAt: '2026-06-21T19:03:17.168Z' },
    { action: 'like_post', occurredAt: '2026-06-21T19:03:17.168Z' },
    { action: 'like_post', occurredAt: '2026-06-23T19:04:06.906Z' },
    { action: 'like_post', occurredAt: '2026-06-23T19:04:06.906Z' },
  ]);

  assert.equal(result.rawPoints, 2.25);
  assert.equal(result.bonusPoints, 2);
});

test('daily cap prevents same-day comment spam from beating attendance calibration', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    ...Array.from({ length: 20 }, (_, index) => ({
      action: 'comment_post',
      occurredAt: `2026-06-20T11:${String(index).padStart(2, '0')}:00.000Z`,
    })),
  ]);

  assert.equal(result.rawPoints, 1.1);
  assert.equal(result.bonusPoints, 1);
});


test('loadSocialRaffleBonuses applies one confidently matched VK profile to all accepted applications of the same person', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE special_applications (
      id INTEGER PRIMARY KEY,
      full_name_fingerprint TEXT
    );
    CREATE TABLE vk_social_actors (
      vk_user_id INTEGER PRIMARY KEY,
      match_status TEXT NOT NULL,
      match_confidence REAL NOT NULL,
      matched_special_application_id INTEGER
    );
    CREATE TABLE vk_social_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      vk_user_id INTEGER NOT NULL,
      activity_date TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO special_applications(id, full_name_fingerprint) VALUES (?, ?)').run(1, 'ivanova anna');
  db.prepare('INSERT INTO special_applications(id, full_name_fingerprint) VALUES (?, ?)').run(2, 'ivanova anna');
  db.prepare('INSERT INTO special_applications(id, full_name_fingerprint) VALUES (?, ?)').run(3, 'petrova olga');
  db.prepare(`
    INSERT INTO vk_social_actors(vk_user_id, match_status, match_confidence, matched_special_application_id)
    VALUES (101, 'matched', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO vk_social_activities(action, vk_user_id, activity_date, created_at)
    VALUES (?, 101, ?, ?)
  `).run('repost_post', '2026-06-20T10:00:00.000Z', '2026-06-20T10:00:00.000Z');
  db.prepare(`
    INSERT INTO vk_social_activities(action, vk_user_id, activity_date, created_at)
    VALUES (?, 101, ?, ?)
  `).run('repost_post', '2026-06-21T10:00:00.000Z', '2026-06-21T10:00:00.000Z');

  const bonuses = loadSocialRaffleBonuses(db, [1, 2, 3]);

  assert.equal(bonuses.get(1)?.bonusPoints, 1);
  assert.equal(bonuses.get(2)?.bonusPoints, 1);
  assert.equal(bonuses.get(2)?.rawPoints, 1.2);
  assert.equal(bonuses.get(3)?.bonusPoints, 0);
});
