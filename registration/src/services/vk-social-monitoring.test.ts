import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  buildVkSocialDailyReport,
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
    fullNameFingerprint: fullName.toLowerCase().replaceAll('ё', 'е'),
    tokens: fullName
      .toLowerCase()
      .replaceAll('ё', 'е')
      .split(/\s+/u)
      .filter(Boolean),
  };
}

function createReportTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vk_social_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_key TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE vk_social_actors (
      vk_user_id INTEGER PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      display_name TEXT NOT NULL,
      action_summary_json TEXT NOT NULL DEFAULT '[]',
      activity_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      match_status TEXT NOT NULL DEFAULT 'unmatched',
      match_method TEXT,
      match_confidence REAL NOT NULL DEFAULT 0,
      matched_special_application_id INTEGER,
      match_reason TEXT,
      match_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE vk_social_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      vk_user_id INTEGER NOT NULL,
      group_id INTEGER,
      post_id INTEGER,
      comment_id INTEGER,
      activity_date TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE vk_social_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_key TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id INTEGER,
      since_at TEXT NOT NULL,
      until_at TEXT NOT NULL,
      since_exclusive INTEGER NOT NULL DEFAULT 1,
      text_hash TEXT NOT NULL,
      telegram_message_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO vk_social_actors(
      vk_user_id,
      first_name,
      last_name,
      display_name,
      action_summary_json,
      activity_count,
      match_status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, '[]', 0, 'unmatched', ?, ?)
  `).run(101, 'Анна', 'Тестова', 'Анна Тестова', '2026-06-17T00:00:00.000Z', '2026-06-17T00:00:00.000Z');
  db.prepare(`
    INSERT INTO vk_social_runs(id, run_key, trigger, status, started_at, finished_at)
    VALUES (?, ?, 'scheduled', 'completed', ?, ?)
  `).run(1, '2026-06-17-21', '2026-06-17T19:00:00.000Z', '2026-06-17T19:05:10.024Z');
  db.prepare(`
    INSERT INTO vk_social_runs(id, run_key, trigger, status, started_at, finished_at)
    VALUES (?, ?, 'scheduled', 'completed', ?, ?)
  `).run(2, '2026-06-18-09', '2026-06-18T07:00:00.000Z', '2026-06-18T07:04:15.343Z');
  return db;
}

function insertActivity(db: Database.Database, input: {
  activityKey: string;
  source: string;
  action: string;
  activityDate?: string | null;
  createdAt: string;
  postId: number;
}) {
  db.prepare(`
    INSERT INTO vk_social_activities(
      activity_key,
      source,
      action,
      vk_user_id,
      group_id,
      post_id,
      comment_id,
      activity_date,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, 101, 231920894, ?, NULL, ?, '{}', ?)
  `).run(
    input.activityKey,
    input.source,
    input.action,
    input.postId,
    input.activityDate ?? null,
    input.createdAt,
  );
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

test('deterministicMatchActor treats same person in several special events as one candidate', () => {
  const result = deterministicMatchActor({
    firstName: 'Сергей',
    lastName: 'Четвериков',
    displayName: 'Сергей Четвериков',
  }, [
    applicant(1, 'Четвериков Сергей Александрович'),
    applicant(2, 'Четвериков Сергей Александрович'),
  ]);

  assert.equal(result.verdict.status, 'matched');
  assert.equal(result.verdict.matchedSpecialApplicationId, 1);
  assert.equal(result.verdict.candidateCount, 1);
  assert.match(result.verdict.reason, /same_person_special_applications=2/u);
});

test('deterministicMatchActor matches common first-name diminutives with exact surname', () => {
  const anna = deterministicMatchActor({
    firstName: 'Анюта',
    lastName: 'Ябурова',
    displayName: 'Анюта Ябурова',
  }, [applicant(1, 'Ябурова Анна Валерьевна')]);

  assert.equal(anna.verdict.status, 'matched');
  assert.equal(anna.verdict.matchedSpecialApplicationId, 1);

  const tatiana = deterministicMatchActor({
    firstName: 'Таня',
    lastName: 'Косицкая',
    displayName: 'Таня Косицкая',
  }, [applicant(2, 'Косицкая Татьяна Евгеньевна')]);

  assert.equal(tatiana.verdict.status, 'matched');
  assert.equal(tatiana.verdict.matchedSpecialApplicationId, 2);
});

test('deterministicMatchActor matches one-letter surname truncation with exact given name', () => {
  const result = deterministicMatchActor({
    firstName: 'Лидия',
    lastName: 'Гофман',
    displayName: 'Лидия Гофман',
  }, [applicant(1, 'Гофма Лидия Васильевна')]);

  assert.equal(result.verdict.status, 'matched');
  assert.equal(result.verdict.matchedSpecialApplicationId, 1);
  assert.match(result.verdict.reason, /surname_given_name_approx/u);
});

test('deterministicMatchActor does not promote loose surname prefix matches to matched', () => {
  const result = deterministicMatchActor({
    firstName: 'Анна',
    lastName: 'Кузнецов',
    displayName: 'Анна Кузнецов',
  }, [applicant(1, 'Кузнеченко Анна Петровна')]);

  assert.notEqual(result.verdict.status, 'matched');
  assert.ok(['weak', 'ambiguous', 'unmatched'].includes(result.verdict.status));
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

test('buildVkSocialDailyReport delta starts after previous sent report without 24h overlap', () => {
  const db = createReportTestDb();
  db.prepare(`
    INSERT INTO vk_social_reports(
      report_key,
      mode,
      status,
      run_id,
      since_at,
      until_at,
      since_exclusive,
      text_hash,
      created_at,
      sent_at,
      updated_at
    ) VALUES (
      'delta:2026-06-16T19:03:54.569Z:2026-06-17T19:05:10.024Z',
      'delta',
      'sent',
      1,
      '2026-06-16T19:03:54.569Z',
      '2026-06-17T19:05:10.024Z',
      1,
      'hash',
      '2026-06-17T19:05:20.000Z',
      '2026-06-17T19:05:20.000Z',
      '2026-06-17T19:05:20.000Z'
    )
  `).run();
  insertActivity(db, {
    activityKey: 'old-like',
    source: 'wall_scan',
    action: 'like_post',
    createdAt: '2026-06-17T19:00:00.000Z',
    postId: 1,
  });
  insertActivity(db, {
    activityKey: 'new-like',
    source: 'wall_scan',
    action: 'like_post',
    createdAt: '2026-06-18T07:00:00.000Z',
    postId: 2,
  });
  insertActivity(db, {
    activityKey: 'old-comment',
    source: 'wall_scan',
    action: 'comment_post',
    activityDate: '2026-06-17T18:00:00.000Z',
    createdAt: '2026-06-17T18:00:10.000Z',
    postId: 3,
  });
  insertActivity(db, {
    activityKey: 'new-comment',
    source: 'wall_scan',
    action: 'comment_post',
    activityDate: '2026-06-18T06:00:00.000Z',
    createdAt: '2026-06-18T06:00:10.000Z',
    postId: 4,
  });

  const report = buildVkSocialDailyReport(db, 'unused-private-key', {
    mode: 'delta',
    currentRunId: 2,
  });

  assert.equal(report.stats.mode, 'delta');
  assert.equal(report.stats.intervalSource, 'previous_sent_report');
  assert.equal(report.stats.sinceIso, '2026-06-17T19:05:10.024Z');
  assert.equal(report.stats.untilIso, '2026-06-18T07:04:15.343Z');
  assert.equal(report.stats.totalActivities, 1);
  assert.equal(report.stats.firstSeenWallScanActivities, 1);
  assert.deepEqual(report.stats.firstSeenWallScanActions, { like_post: 1 });
  assert.match(report.text, /без нахлёста/u);
  assert.match(report.text, /новых точных действий: 1/u);
  assert.match(report.text, /новых впервые найденных сканом без точного времени VK: 1/u);
});

test('buildVkSocialDailyReport delta falls back to previous completed run before first sent report', () => {
  const db = createReportTestDb();
  insertActivity(db, {
    activityKey: 'previous-window-like',
    source: 'wall_scan',
    action: 'like_post',
    createdAt: '2026-06-17T19:04:00.000Z',
    postId: 1,
  });
  insertActivity(db, {
    activityKey: 'current-window-like',
    source: 'wall_scan',
    action: 'like_post',
    createdAt: '2026-06-17T19:06:00.000Z',
    postId: 2,
  });

  const report = buildVkSocialDailyReport(db, 'unused-private-key', {
    mode: 'delta',
    currentRunId: 2,
  });

  assert.equal(report.stats.intervalSource, 'previous_completed_run');
  assert.equal(report.stats.sinceIso, '2026-06-17T19:05:10.024Z');
  assert.equal(report.stats.firstSeenWallScanActivities, 1);
  assert.deepEqual(report.stats.firstSeenWallScanActions, { like_post: 1 });
  assert.match(report.text, /после предыдущего успешного запуска мониторинга/u);
});
