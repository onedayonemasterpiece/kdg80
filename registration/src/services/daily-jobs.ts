import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { InputFile, type Bot, type Context } from 'grammy';
import { createSqliteBackup } from './admin-maintenance';
import { buildRegistrationsXlsxBuffer, listAllRegistrationsForExport } from './registration-exports';
import {
  buildSpecialDrawXlsxBuffer,
  listSpecialShowingsDueForAutoDraw,
  runSpecialDraw,
} from './special-draws';
import { listTelegramAdmins } from './telegram-admins';

type DailyJobDeps = {
  db: Database.Database;
  bot: Bot<Context>;
  logger: FastifyBaseLogger;
  privateKeyPemBase64: string | null;
  timeZone: string;
  syncPublicStateManifest: (reason: string) => Promise<boolean>;
};

const DAILY_EXPORT_JOB = 'daily_export_all';
const DAILY_BACKUP_JOB = 'daily_backup_sqlite';
const DAILY_STATE_MANIFEST_JOB = 'daily_public_state_manifest';
const DAILY_HOUR = 4;
const DAILY_MINUTE = 30;
const POLL_INTERVAL_MS = 60_000;

function getLocalParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? '';

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour') || '0'),
    minute: Number(get('minute') || '0'),
  };
}

function getRunKey(date: Date, timeZone: string) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function hasReachedDailyWindow(date: Date, timeZone: string) {
  const parts = getLocalParts(date, timeZone);
  return parts.hour > DAILY_HOUR || (parts.hour === DAILY_HOUR && parts.minute >= DAILY_MINUTE);
}

function getLastRunKey(db: Database.Database, jobName: string) {
  const row = db.prepare(`
    SELECT last_run_key
    FROM maintenance_jobs
    WHERE job_name = ?
    LIMIT 1
  `).get(jobName) as { last_run_key: string | null } | undefined;

  return row?.last_run_key ?? null;
}

function markJobSuccess(db: Database.Database, jobName: string, runKey: string) {
  db.prepare(`
    INSERT INTO maintenance_jobs(job_name, last_run_key, last_run_at, last_error, updated_at)
    VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), NULL, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(job_name) DO UPDATE SET
      last_run_key = excluded.last_run_key,
      last_run_at = excluded.last_run_at,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(jobName, runKey);
}

function markJobFailure(db: Database.Database, jobName: string, errorMessage: string) {
  db.prepare(`
    INSERT INTO maintenance_jobs(job_name, last_error, updated_at)
    VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(job_name) DO UPDATE SET
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(jobName, errorMessage.slice(0, 500));
}

async function sendDocumentToSuperadmins(
  db: Database.Database,
  bot: Bot<Context>,
  buffer: Buffer,
  filename: string,
  caption: string,
) {
  const superadmins = listTelegramAdmins(db).filter((item) => item.role === 'superadmin');
  if (!superadmins.length) {
    return false;
  }

  const results = await Promise.allSettled(
    superadmins.map((admin) => bot.api.sendDocument(admin.telegramUserId, new InputFile(buffer, filename), {
      caption,
    })),
  );

  const rejected = results.filter((item) => item.status === 'rejected');
  if (rejected.length === results.length) {
    throw new Error('Failed to deliver daily document to every superadmin.');
  }

  return true;
}

async function sendMessageToSuperadmins(
  db: Database.Database,
  bot: Bot<Context>,
  text: string,
) {
  const superadmins = listTelegramAdmins(db).filter((item) => item.role === 'superadmin');
  if (!superadmins.length) {
    return false;
  }

  const results = await Promise.allSettled(
    superadmins.map((admin) => bot.api.sendMessage(admin.telegramUserId, text)),
  );

  const rejected = results.filter((item) => item.status === 'rejected');
  if (rejected.length === results.length) {
    throw new Error('Failed to deliver message to every superadmin.');
  }

  return true;
}

async function runDailyExport(deps: DailyJobDeps) {
  if (!deps.privateKeyPemBase64) {
    throw new Error('Private key is required for daily registrations export.');
  }

  const rows = listAllRegistrationsForExport(deps.db, deps.privateKeyPemBase64);
  const buffer = await buildRegistrationsXlsxBuffer(rows);
  await sendDocumentToSuperadmins(
    deps.db,
    deps.bot,
    buffer,
    'registrations-all.xlsx',
    'Ежедневный XLSX по всем регистрациям.',
  );

  return true;
}

async function runDailyBackup(deps: DailyJobDeps) {
  const buffer = await createSqliteBackup(deps.db, 'registration-daily-backup');
  return sendDocumentToSuperadmins(
    deps.db,
    deps.bot,
    buffer,
    'registration-backup.sqlite',
    'Ежедневная резервная копия SQLite.',
  );
}

async function runDueSpecialDraws(deps: DailyJobDeps, now: Date) {
  if (!deps.privateKeyPemBase64) {
    deps.logger.error('special_auto_draw_skipped_missing_private_key');
    return;
  }

  const dueShowings = listSpecialShowingsDueForAutoDraw(deps.db, now);
  for (const item of dueShowings) {
    try {
      deps.logger.info({
        eventSlug: item.event.slug,
        showingId: item.showing.id,
        showingSlug: item.showing.slug,
        startsAt: item.showing.starts_at,
        autoPublishAt: item.autoPublishAt,
      }, 'special_auto_draw_started');

      const result = runSpecialDraw(deps.db, item.showing.id, 'published', deps.privateKeyPemBase64);
      try {
        const text = [
          'Автоматический опубликованный розыгрыш за сутки до показа.',
          '',
          `${result.event.title}`,
          `${result.showing.display_label}`,
          `Кандидатов: ${result.totalCandidates}`,
          `Победителей: ${result.winners.length} из ${result.showing.lottery_quota}`,
          `Технических билетиков в барабане: ${result.totalWeight}`,
          `Механика: баллы делятся между выбранными датами; полный аудит в XLSX.`,
          `Источник случайности: ${result.drawMechanism.randomSource}`,
        ].join('\n');
        await sendMessageToSuperadmins(deps.db, deps.bot, text);

        const buffer = await buildSpecialDrawXlsxBuffer(result);
        await sendDocumentToSuperadmins(
          deps.db,
          deps.bot,
          buffer,
          `${item.event.slug}-${item.showing.slug}-auto-winners.xlsx`,
          `Автоматический XLSX победителей: ${item.event.title}, ${item.showing.display_label}`,
        );
      } catch (error) {
        deps.logger.error({
          err: error,
          eventSlug: item.event.slug,
          showingId: item.showing.id,
          showingSlug: item.showing.slug,
        }, 'special_auto_draw_notification_failed');
      }

      deps.logger.info({
        eventSlug: item.event.slug,
        showingId: item.showing.id,
        showingSlug: item.showing.slug,
        winners: result.winners.length,
        candidates: result.totalCandidates,
      }, 'special_auto_draw_completed');
    } catch (error) {
      deps.logger.error({
        err: error,
        eventSlug: item.event.slug,
        showingId: item.showing.id,
        showingSlug: item.showing.slug,
      }, 'special_auto_draw_failed');
    }
  }
}

async function maybeRunJob(
  deps: DailyJobDeps,
  jobName: string,
  date: Date,
  runner: () => Promise<boolean>,
) {
  const runKey = getRunKey(date, deps.timeZone);
  if (!hasReachedDailyWindow(date, deps.timeZone)) {
    return;
  }

  if (getLastRunKey(deps.db, jobName) === runKey) {
    return;
  }

  try {
    const completed = await runner();
    if (!completed) {
      deps.logger.info({ jobName, runKey }, 'daily_job_skipped_no_superadmin');
      return;
    }

    markJobSuccess(deps.db, jobName, runKey);
    deps.logger.info({ jobName, runKey }, 'daily_job_completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown daily job error.';
    markJobFailure(deps.db, jobName, message);
    deps.logger.error({ err: error, jobName, runKey }, 'daily_job_failed');
  }
}

export function startDailyJobs(deps: DailyJobDeps) {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const now = new Date();
      const hasSuperadmin = listTelegramAdmins(deps.db).some((item) => item.role === 'superadmin');

      if (hasSuperadmin) {
        await maybeRunJob(deps, DAILY_EXPORT_JOB, now, async () => runDailyExport(deps));
        await maybeRunJob(deps, DAILY_BACKUP_JOB, now, async () => runDailyBackup(deps));
      }

      await maybeRunJob(deps, DAILY_STATE_MANIFEST_JOB, now, async () => deps.syncPublicStateManifest('daily'));
      await runDueSpecialDraws(deps, now);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  void tick();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
