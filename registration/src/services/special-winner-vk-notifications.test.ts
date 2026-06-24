import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Database from 'better-sqlite3';
import type { SpecialDrawResult } from './special-draws';
import { sendSpecialDrawWinnerVkMessages } from './special-winner-vk-notifications';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vk_social_actors (
      vk_user_id INTEGER PRIMARY KEY,
      display_name TEXT NOT NULL,
      match_status TEXT NOT NULL,
      match_confidence REAL NOT NULL,
      matched_special_application_id INTEGER
    );

    CREATE TABLE special_winner_vk_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_run_id INTEGER NOT NULL,
      showing_id INTEGER NOT NULL,
      application_id INTEGER NOT NULL,
      vk_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      message_text TEXT NOT NULL,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(draw_run_id, application_id, vk_user_id)
    );
  `);
  return db;
}

function createDrawResult(fullName: string): SpecialDrawResult {
  return {
    id: 10,
    runType: 'published',
    createdAt: '2026-06-24T16:10:00.000Z',
    event: {
      id: 1,
      slug: 'etudy-toy-vesny',
      title: 'Этюды той весны',
      format_label: 'спектакль',
      venue_name: 'Южный вокзал',
      previous_winner_weight_percent: 50,
    },
    showing: {
      id: 3,
      special_event_id: 1,
      slug: '2026-06-25',
      starts_at: '2026-06-25T18:10:00+02:00',
      display_label: '25 июня 18:10 Южный Вокзал',
      meeting_place: 'У фонтана в здании Южного вокзала',
      time_is_final: 1,
      physical_quota: 30,
      reserved_seats: 0,
      lottery_quota: 30,
      draw_status: 'published',
    },
    totalCandidates: 1,
    totalWeight: 10,
    candidates: [],
    winners: [{
      applicationId: 101,
      applicationCode: 'winner-101',
      participantProfileId: null,
      fullName,
      email: '',
      phone: '',
      status: 'accepted',
      baseScore: 10,
      socialBonusScore: 0,
      socialBonusRawPoints: 0,
      socialActivityCount: 0,
      socialActiveDays: 0,
      socialActivityCounts: {
        like_post: 0,
        like_video: 0,
        like_comment: 0,
        comment_post: 0,
        reply_comment: 0,
        repost_post: 0,
      },
      score: 10,
      stampCount: 5,
      ordinaryRegistrationCount: 5,
      noShowCount: 0,
      uploadedPhotoCount: 1,
      uniquePhotoCount: 1,
      acceptedPhotoCount: 1,
      selectedShowingCount: 1,
      previousSpecialWinner: false,
      previousWinnerWeightPercent: 100,
      createdAt: '2026-06-20T10:00:00.000Z',
      position: 1,
      selectedTicket: 1,
      ticketRangeStart: 1,
      ticketRangeEnd: 10,
      showingWeightNumerator: 10,
      showingWeightDenominator: 1,
      drawWeight: 10,
      poolWeightBeforeDraw: 10,
      randomSource: 'test',
    }],
    drawMechanism: {
      algorithm: 'distributed_weighted_ticket_draw_without_replacement',
      ticketRule: 'base_score_damped_social_bonus_undamped_divided_by_selected_showing_count',
      randomSource: 'test',
      audit: [],
    },
  };
}

function installVkFetchMock(groupItems: Array<{ id: number; first_name: string; last_name: string }>) {
  const calls: Array<{ method: string; body: URLSearchParams }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL, init?: RequestInit) => {
    const method = String(input).split('/method/')[1] ?? '';
    const body = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ''));
    calls.push({ method, body });

    if (method === 'groups.getMembers') {
      return new Response(JSON.stringify({
        response: {
          count: groupItems.length,
          items: groupItems,
        },
      }));
    }

    if (method === 'messages.send') {
      return new Response(JSON.stringify({ response: 123 }));
    }

    return new Response(JSON.stringify({
      error: {
        error_code: 3,
        error_msg: `unexpected method ${method}`,
      },
    }));
  }) as typeof fetch);

  return { calls, fetchMock };
}

test('falls back to a unique exact-name VK subscriber match', async () => {
  const db = createDb();
  const { calls, fetchMock } = installVkFetchMock([
    { id: 501, first_name: 'Мария', last_name: 'Иванова' },
  ]);

  try {
    const summary = await sendSpecialDrawWinnerVkMessages({
      db,
      result: createDrawResult('Иванова Мария Петровна'),
      vkToken: 'token',
    });

    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.results[0].vkUserId, 501);
    assert.equal(summary.results[0].source, 'vk_group_subscriber_exact_name');
    assert.equal(calls.filter((item) => item.method === 'messages.send').length, 1);
    assert.match(calls.find((item) => item.method === 'messages.send')?.body.get('message') ?? '', /25 июня 2026 г. в 18:10/u);
    assert.match(calls.find((item) => item.method === 'messages.send')?.body.get('message') ?? '', /У фонтана в здании Южного вокзала/u);
  } finally {
    fetchMock.mock.restore();
    db.close();
  }
});

test('does not send when VK subscriber exact-name match is ambiguous', async () => {
  const db = createDb();
  const { calls, fetchMock } = installVkFetchMock([
    { id: 501, first_name: 'Мария', last_name: 'Иванова' },
    { id: 502, first_name: 'Мария', last_name: 'Иванова' },
  ]);

  try {
    const summary = await sendSpecialDrawWinnerVkMessages({
      db,
      result: createDrawResult('Иванова Мария Петровна'),
      vkToken: 'token',
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.results[0].reason, 'multiple_vk_subscriber_name_matches');
    assert.equal(calls.filter((item) => item.method === 'messages.send').length, 0);
  } finally {
    fetchMock.mock.restore();
    db.close();
  }
});
