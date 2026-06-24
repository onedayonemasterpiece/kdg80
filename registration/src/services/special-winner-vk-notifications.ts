import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { SpecialDrawResult } from './special-draws';

const VK_API_BASE_URL = 'https://api.vk.com/method/';
const VK_API_VERSION = process.env.VK_API_VERSION?.trim() || '5.199';
const MATCH_CONFIDENCE_MIN = 0.85;
const DEFAULT_WINNER_SUBSCRIBER_GROUP_IDS = [231920894, 231828790];

type WinnerVkNotificationStatus = 'sent' | 'failed' | 'skipped';
type WinnerVkRecipientSource = 'social_activity_match' | 'vk_group_subscriber_exact_name';

type WinnerVkNotificationResult = {
  applicationId: number;
  applicationCode: string;
  fullName: string;
  status: WinnerVkNotificationStatus;
  vkUserId: number | null;
  source?: WinnerVkRecipientSource;
  reason?: string;
  error?: string;
};

export type SpecialWinnerVkNotificationSummary = {
  sent: number;
  failed: number;
  skipped: number;
  results: WinnerVkNotificationResult[];
};

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readIntegerList(value: string | undefined, fallback: number[]) {
  const parsed = String(value ?? '')
    .split(/[,;\s]+/u)
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length ? Array.from(new Set(parsed)) : fallback;
}

function tableExists(db: Database.Database, tableName: string) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function formatKaliningradDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(value));
}

function firstNameFromFullName(value: string) {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length >= 2) {
    return parts[1];
  }
  return parts[0] || '';
}

function normalizeNamePart(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/[^a-zа-я0-9-]+/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildPersonKey(lastName: string, firstName: string) {
  const normalizedLastName = normalizeNamePart(lastName);
  const normalizedFirstName = normalizeNamePart(firstName);
  if (!normalizedLastName || !normalizedFirstName) {
    return null;
  }
  return `${normalizedLastName}\u0000${normalizedFirstName}`;
}

function winnerNameKey(fullName: string) {
  const parts = fullName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return buildPersonKey(parts[0], parts[1]);
}

function buildWinnerMessage(result: SpecialDrawResult, winner: SpecialDrawResult['winners'][number]) {
  const firstName = firstNameFromFullName(winner.fullName);
  const greeting = firstName ? `${firstName}, поздравляем!` : 'Поздравляем!';
  const meetingPlace = result.showing.meeting_place?.trim();
  return [
    greeting,
    '',
    `Вы выиграли пригласительный билет на «${result.event.title}».`,
    `Показ: ${formatKaliningradDateTime(result.showing.starts_at)}.`,
    meetingPlace ? `Место встречи: ${meetingPlace}.` : `${result.event.venue_name}.`,
    '',
    'Пожалуйста, приходите за 10–15 минут до начала и возьмите с собой паспорт участника фестиваля.',
    'Сообщение создано автоматически.',
  ].join('\n');
}

type RecipientLookupResult = {
  status: 'found';
  vkUserId: number;
  source: WinnerVkRecipientSource;
  reason?: string;
} | {
  status: 'skipped';
  reason: string;
  vkUserId: null;
};

function findConfidentVkRecipient(db: Database.Database, applicationId: number) {
  if (!tableExists(db, 'vk_social_actors')) {
    return { status: 'skipped' as const, reason: 'vk_social_actors_missing', vkUserId: null };
  }

  const rows = db.prepare(`
    SELECT vk_user_id, display_name, match_confidence
    FROM vk_social_actors
    WHERE matched_special_application_id = ?
      AND match_status = 'matched'
      AND match_confidence >= ?
    ORDER BY match_confidence DESC, vk_user_id ASC
  `).all(applicationId, MATCH_CONFIDENCE_MIN) as Array<{
    vk_user_id: number;
    display_name: string;
    match_confidence: number;
  }>;

  if (rows.length !== 1) {
    return {
      status: 'skipped' as const,
      reason: rows.length === 0 ? 'no_confident_vk_match' : 'multiple_confident_vk_matches',
      vkUserId: null,
    };
  }

  return {
    status: 'found' as const,
    vkUserId: rows[0].vk_user_id,
    source: 'social_activity_match' as const,
    displayName: rows[0].display_name,
    confidence: rows[0].match_confidence,
  };
}

async function callVkApi<T>(
  token: string,
  method: string,
  params: Record<string, string>,
  timeoutMs: number,
) {
  const body = new URLSearchParams();
  body.set('access_token', token);
  body.set('v', VK_API_VERSION);
  for (const [key, value] of Object.entries(params)) {
    body.set(key, value);
  }

  const maxRetries = readPositiveInteger(process.env.VK_WINNER_API_MAX_RETRIES, 4);
  const retryBaseMs = readPositiveInteger(process.env.VK_WINNER_API_RETRY_BASE_MS, 1_100);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${VK_API_BASE_URL}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json() as { response?: T; error?: { error_code: number; error_msg: string } };
    if (!json.error) {
      return json.response as T;
    }

    if (json.error.error_code === 6 && attempt < maxRetries) {
      await sleep(retryBaseMs * (attempt + 1));
      continue;
    }

    throw new Error(`VK ${method} ${json.error.error_code}: ${json.error.error_msg}`);
  }

  throw new Error(`VK ${method}: retries exhausted.`);
}

async function sendVkMessage(token: string, vkUserId: number, message: string) {
  return callVkApi<number>(
    token,
    'messages.send',
    {
      user_id: String(vkUserId),
      random_id: String(crypto.randomInt(1, 2_147_483_647)),
      message,
    },
    readPositiveInteger(process.env.VK_WINNER_MESSAGE_TIMEOUT_MS, 25_000),
  );
}

type VkGroupMember = {
  id: number;
  first_name?: string;
  last_name?: string;
  deactivated?: string;
};

type VkGroupMembersResponse = {
  count: number;
  items: VkGroupMember[];
};

type SubscriberMatch = {
  vkUserId: number;
  firstName: string;
  lastName: string;
  groupIds: Set<number>;
};

type SubscriberIndex = Map<string, Map<number, SubscriberMatch>>;

async function fetchWinnerSubscriberIndex(token: string, logger?: FastifyBaseLogger) {
  const groupIds = readIntegerList(
    process.env.VK_WINNER_FOLLOWER_GROUP_IDS,
    DEFAULT_WINNER_SUBSCRIBER_GROUP_IDS,
  );
  const pageSize = Math.min(readPositiveInteger(process.env.VK_WINNER_FOLLOWER_PAGE_SIZE, 1000), 1000);
  const maxMembersPerGroup = readPositiveInteger(process.env.VK_WINNER_FOLLOWER_MAX_MEMBERS_PER_GROUP, 50_000);
  const minIntervalMs = readPositiveInteger(process.env.VK_WINNER_FOLLOWER_API_MIN_INTERVAL_MS, 1_100);
  const index: SubscriberIndex = new Map();

  for (const groupId of groupIds) {
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total && offset < maxMembersPerGroup) {
      const response = await callVkApi<VkGroupMembersResponse>(
        token,
        'groups.getMembers',
        {
          group_id: String(groupId),
          count: String(Math.min(pageSize, maxMembersPerGroup - offset)),
          offset: String(offset),
          fields: 'screen_name',
        },
        readPositiveInteger(process.env.VK_WINNER_FOLLOWER_TIMEOUT_MS, 25_000),
      );
      total = Number.isFinite(response.count) ? response.count : offset + response.items.length;

      for (const item of response.items ?? []) {
        if (!item || !item.id || item.deactivated) {
          continue;
        }
        const key = buildPersonKey(item.last_name ?? '', item.first_name ?? '');
        if (!key) {
          continue;
        }
        let byUserId = index.get(key);
        if (!byUserId) {
          byUserId = new Map();
          index.set(key, byUserId);
        }
        const existing = byUserId.get(item.id);
        if (existing) {
          existing.groupIds.add(groupId);
        } else {
          byUserId.set(item.id, {
            vkUserId: item.id,
            firstName: item.first_name ?? '',
            lastName: item.last_name ?? '',
            groupIds: new Set([groupId]),
          });
        }
      }

      offset += response.items?.length ?? 0;
      if (!response.items?.length) {
        break;
      }
      if (offset < total && offset < maxMembersPerGroup) {
        await sleep(minIntervalMs);
      }
    }

    if (total > maxMembersPerGroup) {
      logger?.warn({ groupId, total, maxMembersPerGroup }, 'special_winner_vk_subscribers_truncated');
    }
  }

  return index;
}

function findUniqueSubscriberRecipient(
  index: SubscriberIndex,
  winner: SpecialDrawResult['winners'][number],
): RecipientLookupResult {
  const key = winnerNameKey(winner.fullName);
  if (!key) {
    return { status: 'skipped', reason: 'winner_name_not_matchable', vkUserId: null };
  }

  const matches = Array.from(index.get(key)?.values() ?? []);
  if (!matches.length) {
    return { status: 'skipped', reason: 'no_vk_subscriber_name_match', vkUserId: null };
  }
  if (matches.length !== 1) {
    return { status: 'skipped', reason: 'multiple_vk_subscriber_name_matches', vkUserId: null };
  }

  return {
    status: 'found',
    vkUserId: matches[0].vkUserId,
    source: 'vk_group_subscriber_exact_name',
    reason: `groups:${Array.from(matches[0].groupIds).sort((a, b) => a - b).join(',')}`,
  };
}

function ensurePendingNotification(
  db: Database.Database,
  result: SpecialDrawResult,
  winner: SpecialDrawResult['winners'][number],
  vkUserId: number,
  message: string,
) {
  if (!tableExists(db, 'special_winner_vk_notifications')) {
    return { shouldSend: true, status: null as string | null };
  }

  const existing = db.prepare(`
    SELECT status
    FROM special_winner_vk_notifications
    WHERE draw_run_id = ? AND application_id = ? AND vk_user_id = ?
    LIMIT 1
  `).get(result.id, winner.applicationId, vkUserId) as { status: string } | undefined;
  if (existing?.status === 'sent') {
    return { shouldSend: false, status: 'sent' };
  }

  db.prepare(`
    INSERT INTO special_winner_vk_notifications(
      draw_run_id,
      showing_id,
      application_id,
      vk_user_id,
      status,
      message_text
    ) VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(draw_run_id, application_id, vk_user_id) DO UPDATE SET
      status = 'pending',
      error = NULL,
      message_text = excluded.message_text,
      updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(result.id, result.showing.id, winner.applicationId, vkUserId, message);
  return { shouldSend: true, status: 'pending' };
}

function markNotification(
  db: Database.Database,
  result: SpecialDrawResult,
  winner: SpecialDrawResult['winners'][number],
  vkUserId: number,
  status: 'sent' | 'failed',
  error: string | null,
) {
  if (!tableExists(db, 'special_winner_vk_notifications')) {
    return;
  }
  db.prepare(`
    UPDATE special_winner_vk_notifications
    SET status = ?,
        error = ?,
        sent_at = CASE WHEN ? = 'sent' THEN (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE sent_at END,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE draw_run_id = ? AND application_id = ? AND vk_user_id = ?
  `).run(status, error, status, result.id, winner.applicationId, vkUserId);
}

export async function sendSpecialDrawWinnerVkMessages(deps: {
  db: Database.Database;
  result: SpecialDrawResult;
  vkToken: string | null;
  logger?: FastifyBaseLogger;
}): Promise<SpecialWinnerVkNotificationSummary> {
  const summary: SpecialWinnerVkNotificationSummary = {
    sent: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  if (!deps.vkToken) {
    for (const winner of deps.result.winners) {
      summary.skipped += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'skipped',
        vkUserId: null,
        reason: 'vk_token_missing',
      });
    }
    return summary;
  }

  let subscriberIndex: SubscriberIndex | null = null;
  let subscriberLookupError: string | null = null;
  let lastMessageAttemptAt = 0;
  const findSubscriberRecipient = async (winner: SpecialDrawResult['winners'][number]) => {
    if (subscriberLookupError) {
      return { status: 'skipped' as const, reason: subscriberLookupError, vkUserId: null };
    }
    try {
      subscriberIndex ??= await fetchWinnerSubscriberIndex(deps.vkToken as string, deps.logger);
      return findUniqueSubscriberRecipient(subscriberIndex, winner);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      subscriberLookupError = `vk_subscriber_lookup_failed: ${message.slice(0, 180)}`;
      deps.logger?.warn({ err: error }, 'special_winner_vk_subscriber_lookup_failed');
      return { status: 'skipped' as const, reason: subscriberLookupError, vkUserId: null };
    }
  };
  const waitBeforeMessageAttempt = async () => {
    const minIntervalMs = readPositiveInteger(process.env.VK_WINNER_MESSAGE_MIN_INTERVAL_MS, 3_000);
    if (lastMessageAttemptAt > 0) {
      const elapsedMs = Date.now() - lastMessageAttemptAt;
      if (elapsedMs < minIntervalMs) {
        await sleep(minIntervalMs - elapsedMs);
      }
    }
    lastMessageAttemptAt = Date.now();
  };

  for (const winner of deps.result.winners) {
    const socialRecipient = findConfidentVkRecipient(deps.db, winner.applicationId);
    const recipient: RecipientLookupResult = socialRecipient.status === 'found'
      ? socialRecipient
      : await findSubscriberRecipient(winner);
    if (recipient.status === 'skipped' || !recipient.vkUserId) {
      summary.skipped += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'skipped',
        vkUserId: null,
        reason: recipient.reason,
      });
      continue;
    }

    const message = buildWinnerMessage(deps.result, winner);
    const pending = ensurePendingNotification(deps.db, deps.result, winner, recipient.vkUserId, message);
    if (!pending.shouldSend) {
      summary.skipped += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'skipped',
        vkUserId: recipient.vkUserId,
        source: recipient.source,
        reason: 'already_sent',
      });
      continue;
    }

    try {
      await waitBeforeMessageAttempt();
      await sendVkMessage(deps.vkToken, recipient.vkUserId, message);
      markNotification(deps.db, deps.result, winner, recipient.vkUserId, 'sent', null);
      summary.sent += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'sent',
        vkUserId: recipient.vkUserId,
        source: recipient.source,
        reason: recipient.reason,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      markNotification(deps.db, deps.result, winner, recipient.vkUserId, 'failed', messageText.slice(0, 500));
      deps.logger?.warn({ err: error, applicationId: winner.applicationId, vkUserId: recipient.vkUserId }, 'special_winner_vk_message_failed');
      summary.failed += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'failed',
        vkUserId: recipient.vkUserId,
        source: recipient.source,
        error: messageText,
      });
    }
  }

  return summary;
}

export function formatSpecialWinnerVkNotificationSummary(summary: SpecialWinnerVkNotificationSummary) {
  return [
    `VK-сообщения победителям: отправлено ${summary.sent}, ошибок ${summary.failed}, пропущено ${summary.skipped}.`,
    ...summary.results.slice(0, 20).map((item) => [
      `• ${item.fullName}: ${item.status}`,
      item.vkUserId ? `VK id ${item.vkUserId}` : null,
      item.source ? `источник: ${item.source}` : null,
      item.reason ? `причина: ${item.reason}` : null,
      item.error ? `ошибка: ${item.error}` : null,
    ].filter(Boolean).join('; ')),
    summary.results.length > 20 ? `…и ещё ${summary.results.length - 20}` : null,
  ].filter(Boolean).join('\n');
}
