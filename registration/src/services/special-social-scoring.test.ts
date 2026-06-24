import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSocialRaffleBonusFromActivities } from './special-social-scoring';

test('two strong social days equal one additional stamp score point pair', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:05:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:06:00.000Z' },
    { action: 'repost_post', occurredAt: '2026-06-21T10:00:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-21T10:05:00.000Z' },
    { action: 'reply_comment', occurredAt: '2026-06-21T10:06:00.000Z' },
  ]);

  assert.equal(result.rawPoints, 2);
  assert.equal(result.bonusPoints, 2);
  assert.equal(result.activeDays, 2);
});

test('likes alone are capped below a strong repost/comment day', () => {
  const result = computeSocialRaffleBonusFromActivities(1, Array.from({ length: 20 }, (_, index) => ({
    action: 'like_post',
    occurredAt: `2026-06-20T10:${String(index).padStart(2, '0')}:00.000Z`,
  })));

  assert.equal(result.rawPoints, 0.15);
  assert.equal(result.bonusPoints, 0);
});

test('accumulated raw score above one point rounds up across the whole stored period', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-19T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-20T10:01:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:00:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-23T10:00:00.000Z' },
  ]);

  assert.equal(result.rawPoints, 1);
  assert.equal(result.bonusPoints, 1);

  const withSmallAccumulatedTail = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:01:00.000Z' },
    { action: 'comment_post', occurredAt: '2026-06-20T10:02:00.000Z' },
    { action: 'like_post', occurredAt: '2026-06-21T10:00:00.000Z' },
  ]);

  assert.equal(withSmallAccumulatedTail.rawPoints, 1.1);
  assert.equal(withSmallAccumulatedTail.bonusPoints, 2);
});

test('daily cap prevents same-day comment spam from beating attendance calibration', () => {
  const result = computeSocialRaffleBonusFromActivities(1, [
    { action: 'repost_post', occurredAt: '2026-06-20T10:00:00.000Z' },
    ...Array.from({ length: 20 }, (_, index) => ({
      action: 'comment_post',
      occurredAt: `2026-06-20T11:${String(index).padStart(2, '0')}:00.000Z`,
    })),
  ]);

  assert.equal(result.rawPoints, 1);
  assert.equal(result.bonusPoints, 1);
});
