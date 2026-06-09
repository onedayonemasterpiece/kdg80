import type Database from 'better-sqlite3';
import { getLlmLimiterSnapshot } from '../lib/llm-rate-limiter';

type CountRow = {
  count: number;
};

type OutboxTypeRow = {
  type: string;
  count: number;
};

type OutboxStatsRow = {
  total_count: number;
  due_count: number;
  delayed_count: number;
  failed_count: number;
  oldest_created_at: string | null;
  oldest_due_at: string | null;
  newest_created_at: string | null;
  max_attempt_count: number | null;
  last_error: string | null;
};

type MaintenanceJobRow = {
  job_name: string;
  last_run_key: string | null;
  last_run_at: string | null;
  last_error: string | null;
  updated_at: string;
};

function parseDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function ageLabel(value: string | null | undefined, now = Date.now()) {
  const timestamp = parseDate(value);
  if (!timestamp) {
    return 'нет данных';
  }

  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds} сек назад`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} ч назад`;
  }

  return `${Math.round(hours / 24)} дн назад`;
}

function formatIso(value: string | null | undefined) {
  if (!value) {
    return 'нет данных';
  }

  return value.replace(/\.\d{3}Z$/u, 'Z');
}

function isOlderThan(value: string | null | undefined, thresholdMs: number, now = Date.now()) {
  const timestamp = parseDate(value);
  return timestamp !== null && now - timestamp > thresholdMs;
}

function getMaintenanceJob(db: Database.Database, jobName: string) {
  return db.prepare(`
    SELECT job_name, last_run_key, last_run_at, last_error, updated_at
    FROM maintenance_jobs
    WHERE job_name = ?
    LIMIT 1
  `).get(jobName) as MaintenanceJobRow | undefined;
}

export function formatAdminDiagnostics(db: Database.Database) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const outbox = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN not_before <= ? THEN 1 ELSE 0 END) AS due_count,
      SUM(CASE WHEN not_before > ? THEN 1 ELSE 0 END) AS delayed_count,
      SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed_count,
      MIN(created_at) AS oldest_created_at,
      MIN(not_before) AS oldest_due_at,
      MAX(created_at) AS newest_created_at,
      MAX(attempt_count) AS max_attempt_count,
      (
        SELECT last_error
        FROM telegram_outbox
        WHERE last_error IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      ) AS last_error
    FROM telegram_outbox
  `).get(nowIso, nowIso) as OutboxStatsRow;
  const outboxByType = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM telegram_outbox
    GROUP BY type
    ORDER BY type ASC
  `).all() as OutboxTypeRow[];
  const specialApplicationCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM special_applications
  `).get() as CountRow;
  const specialPhotoCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM special_application_photos
  `).get() as CountRow;
  const telegramHeartbeat = getMaintenanceJob(db, 'telegram_outbox_tick');
  const telegramSuccess = getMaintenanceJob(db, 'telegram_outbox_success');
  const telegramError = getMaintenanceJob(db, 'telegram_outbox_error');
  const llm = getLlmLimiterSnapshot();

  const warnings: string[] = [];
  if ((outbox.due_count ?? 0) > 0 && isOlderThan(outbox.oldest_due_at, 10 * 60 * 1000, nowMs)) {
    warnings.push('есть ожидающие Telegram-сообщения старше 10 минут');
  }
  if ((outbox.failed_count ?? 0) > 0 && (outbox.max_attempt_count ?? 0) >= 3) {
    warnings.push('есть Telegram-сообщения с повторными ошибками');
  }
  if (!telegramHeartbeat?.last_run_at) {
    warnings.push('heartbeat Telegram outbox ещё не зафиксирован после запуска');
  } else if (isOlderThan(telegramHeartbeat.last_run_at, 60 * 1000, nowMs)) {
    warnings.push('heartbeat Telegram outbox старше 1 минуты');
  }
  if ((llm.queuedCount > 0 || llm.activeCount > 0) && isOlderThan(llm.lastRunStartedAt, 10 * 60 * 1000, nowMs)) {
    warnings.push('OCR/LLM limiter показывает долгую активную или ожидающую задачу');
  }

  const status = warnings.length ? 'Требует внимания' : 'В порядке';
  const byType = outboxByType.length
    ? outboxByType.map((row) => `${row.type}: ${row.count}`).join(', ')
    : 'нет';

  const lines = [
    'Диагностика спецмероприятий',
    `Итог: ${status}`,
    `Проверено: ${formatIso(nowIso)}`,
    '',
    'Telegram outbox',
    `Очередь: всего ${outbox.total_count ?? 0}, к отправке ${outbox.due_count ?? 0}, отложено ${outbox.delayed_count ?? 0}, с ошибкой ${outbox.failed_count ?? 0}`,
    `Типы: ${byType}`,
    `Старейший элемент: ${formatIso(outbox.oldest_created_at)} (${ageLabel(outbox.oldest_created_at, nowMs)})`,
    `Старейший срок отправки: ${formatIso(outbox.oldest_due_at)} (${ageLabel(outbox.oldest_due_at, nowMs)})`,
    `Последний heartbeat: ${formatIso(telegramHeartbeat?.last_run_at)} (${ageLabel(telegramHeartbeat?.last_run_at, nowMs)})`,
    `Последняя успешная отправка: ${formatIso(telegramSuccess?.last_run_at)} (${ageLabel(telegramSuccess?.last_run_at, nowMs)})`,
    `Последняя ошибка отправки: ${formatIso(telegramError?.last_run_at)} (${ageLabel(telegramError?.last_run_at, nowMs)})`,
    telegramError?.last_error ? `Текст последней ошибки: ${telegramError.last_error.slice(0, 240)}` : null,
    '',
    'OCR/LLM limiter',
    `Очередь: ожидает ${llm.queuedCount}, выполняется ${llm.activeCount}`,
    `Последняя постановка: ${formatIso(llm.lastEnqueuedAt)} (${ageLabel(llm.lastEnqueuedAt, nowMs)})`,
    `Последний запуск: ${formatIso(llm.lastRunStartedAt)} (${ageLabel(llm.lastRunStartedAt, nowMs)})`,
    `Последний успех: ${formatIso(llm.lastSucceededAt)} (${ageLabel(llm.lastSucceededAt, nowMs)})`,
    `Последняя ошибка: ${formatIso(llm.lastFailedAt)} (${ageLabel(llm.lastFailedAt, nowMs)})`,
    llm.lastError ? `Текст последней OCR/LLM ошибки: ${llm.lastError.slice(0, 240)}` : null,
    '',
    'Данные спецмероприятий',
    `Заявок: ${specialApplicationCount.count}`,
    `Фото в учёте: ${specialPhotoCount.count}`,
    warnings.length ? `Предупреждения: ${warnings.join('; ')}` : 'Предупреждений нет.',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}
