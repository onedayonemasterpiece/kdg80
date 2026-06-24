import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { SpecialDrawResult } from './special-draws';

const VK_API_BASE_URL = 'https://api.vk.com/method/';
const VK_API_VERSION = process.env.VK_API_VERSION?.trim() || '5.199';
const MATCH_CONFIDENCE_MIN = 0.85;

type WinnerVkNotificationStatus = 'sent' | 'failed' | 'skipped';

type WinnerVkNotificationResult = {
  applicationId: number;
  applicationCode: string;
  fullName: string;
  status: WinnerVkNotificationStatus;
  vkUserId: number | null;
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
    status: 'sent' as const,
    vkUserId: rows[0].vk_user_id,
    displayName: rows[0].display_name,
    confidence: rows[0].match_confidence,
  };
}

async function sendVkMessage(token: string, vkUserId: number, message: string) {
  const body = new URLSearchParams();
  body.set('access_token', token);
  body.set('v', VK_API_VERSION);
  body.set('user_id', String(vkUserId));
  body.set('random_id', String(crypto.randomInt(1, 2_147_483_647)));
  body.set('message', message);

  const response = await fetch(`${VK_API_BASE_URL}messages.send`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(readPositiveInteger(process.env.VK_WINNER_MESSAGE_TIMEOUT_MS, 25_000)),
  });
  const json = await response.json() as { response?: number; error?: { error_code: number; error_msg: string } };
  if (json.error) {
    throw new Error(`VK messages.send ${json.error.error_code}: ${json.error.error_msg}`);
  }
  return json.response ?? 0;
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

  for (const winner of deps.result.winners) {
    const recipient = findConfidentVkRecipient(deps.db, winner.applicationId);
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
        reason: 'already_sent',
      });
      continue;
    }

    try {
      await sendVkMessage(deps.vkToken, recipient.vkUserId, message);
      markNotification(deps.db, deps.result, winner, recipient.vkUserId, 'sent', null);
      summary.sent += 1;
      summary.results.push({
        applicationId: winner.applicationId,
        applicationCode: winner.applicationCode,
        fullName: winner.fullName,
        status: 'sent',
        vkUserId: recipient.vkUserId,
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
      item.reason ? `причина: ${item.reason}` : null,
      item.error ? `ошибка: ${item.error}` : null,
    ].filter(Boolean).join('; ')),
    summary.results.length > 20 ? `…и ещё ${summary.results.length - 20}` : null,
  ].filter(Boolean).join('\n');
}
