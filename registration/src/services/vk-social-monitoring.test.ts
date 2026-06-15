import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivityKey,
  deterministicMatchActor,
  parseNotificationActivities,
  type SpecialApplicant,
} from './vk-social-monitoring';

function applicant(id: number, fullName: string): SpecialApplicant {
  return {
    id,
    applicationCode: `SP-${id}`,
    status: 'submitted',
    fullName,
    tokens: fullName
      .toLowerCase()
      .replaceAll('ё', 'е')
      .split(/\s+/u)
      .filter(Boolean),
  };
}

test('parseNotificationActivities reads feedback.from_id for comments', () => {
  const { actors, activities } = parseNotificationActivities({
    items: [{
      type: 'comment_post',
      date: 1_720_000_000,
      feedback: { id: 777, from_id: 101 },
      parent: { owner_id: -231920894, post_id: 55 },
    }],
    profiles: [{ id: 101, first_name: 'Анна', last_name: 'Иванова', is_closed: true }],
  });

  assert.equal(actors.size, 1);
  assert.equal(actors.get(101)?.displayName, 'Анна Иванова');
  assert.equal(activities.size, 1);
  const activity = [...activities.values()][0];
  assert.equal(activity.action, 'comment_post');
  assert.equal(activity.groupId, 231920894);
  assert.equal(activity.postId, 55);
  assert.equal(activity.commentId, 777);
});

test('parseNotificationActivities reads feedback.items[].from_id for likes', () => {
  const { actors, activities } = parseNotificationActivities({
    items: [{
      type: 'like_post',
      date: 1_720_000_001,
      feedback: { items: [{ from_id: 201 }, { from_id: 202 }] },
      parent: { owner_id: -231828790, post_id: 88 },
    }],
    profiles: [
      { id: 201, first_name: 'Иван', last_name: 'Петров' },
      { id: 202, first_name: 'Ольга', last_name: 'Сидорова' },
    ],
  });

  assert.equal(actors.size, 2);
  assert.equal(activities.size, 2);
  assert.deepEqual([...activities.values()].map((item) => item.action), ['like_post', 'like_post']);
});

test('buildActivityKey dedupes same activity from notifications and wall scan', () => {
  const left = buildActivityKey({ action: 'like_post', vkUserId: 201, groupId: 231920894, postId: 12, commentId: null });
  const right = buildActivityKey({ action: 'like_post', vkUserId: 201, groupId: 231920894, postId: 12, commentId: null });
  assert.equal(left, right);
});

test('deterministicMatchActor matches swapped first/last display order', () => {
  const result = deterministicMatchActor({
    firstName: 'Полина',
    lastName: 'Борисова',
    displayName: 'Полина Борисова',
  }, [applicant(1, 'Борисова Полина Сергеевна')]);

  assert.equal(result.verdict.status, 'matched');
  assert.equal(result.verdict.matchedSpecialApplicationId, 1);
});

test('deterministicMatchActor keeps patronymic-only profile below high-confidence', () => {
  const result = deterministicMatchActor({
    firstName: 'Ольга',
    lastName: 'Петровна',
    displayName: 'Ольга Петровна',
  }, [applicant(1, 'Иванова Ольга Петровна')]);

  assert.notEqual(result.verdict.status, 'matched');
  assert.ok(['weak', 'ambiguous', 'unmatched'].includes(result.verdict.status));
});

test('deterministicMatchActor marks duplicate names ambiguous', () => {
  const result = deterministicMatchActor({
    firstName: 'Светлана',
    lastName: 'Светлана',
    displayName: 'Светлана Светлана',
  }, [
    applicant(1, 'Петрова Светлана Ивановна'),
    applicant(2, 'Иванова Светлана Петровна'),
  ]);

  assert.equal(result.verdict.status, 'ambiguous');
  assert.equal(result.verdict.matchedSpecialApplicationId, null);
});

test('deterministicMatchActor rejects organization-like names', () => {
  const result = deterministicMatchActor({
    firstName: 'Полюбить',
    lastName: 'Калининград',
    displayName: 'Полюбить Калининград',
  }, [applicant(1, 'Калининград Полюбить Иванович')]);

  assert.equal(result.verdict.status, 'unmatched');
  assert.equal(result.verdict.reason, 'vk_display_name_looks_like_organization');
});

test('deterministicMatchActor can match closed profiles when names are available', () => {
  const result = deterministicMatchActor({
    firstName: 'Анна',
    lastName: 'Иванова',
    displayName: 'Анна Иванова',
  }, [applicant(1, 'Иванова Анна Петровна')]);

  assert.equal(result.verdict.status, 'matched');
});
