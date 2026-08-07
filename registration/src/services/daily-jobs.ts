import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { InputFile, type Bot, type Context } from 'grammy';
import { createSqliteBackup } from './admin-maintenance';
import { buildRegistrationsXlsxBuffer, listAllRegistrationsForExport } from './registration-exports';
import {
  buildSpecialDrawXlsxBuffer,
  listSpecialShowingsDueForAutoDraw,
  runSpecialDraw,
  type SpecialDrawResult,
} from './special-draws';
import type { EmailNotificationService, EmailSendResult, SpecialWinnerEmailInput } from './email-notifications';
import { recordEmailNotification } from './email-stats';
import { listTelegramAdmins } from './telegram-admins';

type DailyJobDeps = {
  db: Database.Database;
  bot: Bot<Context>;
  logger: FastifyBaseLogger;
  privateKeyPemBase64: string | null;
  timeZone: string;
  syncPublicStateManifest: (reason: string) => Promise<boolean>;
  emailNotifications: EmailNotificationService;
  fingerprintSecret: string | null;
  postboxConfigurationSetName: string | null;
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

function acceptedWinnerEmailExists(db: Database.Database, applicationId: number) {
  const row = db.prepare(`
    SELECT 1 AS found
    FROM email_notifications
    WHERE entity_type = 'special_application'
      AND entity_id = ?
      AND template = 'special_draw_winner'
      AND status != 'send_failed'
    LIMIT 1
  `).get(applicationId) as { found: number } | undefined;
  return Boolean(row?.found);
}

async function sendWinnerEmailWithRetry(
  service: EmailNotificationService,
  input: SpecialWinnerEmailInput,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await service.sendSpecialWinner(input);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
  }

  return {
    sent: false,
    provider: 'yandex-postbox',
    messageId: null,
    reason: lastError instanceof Error ? lastError.message.slice(0, 240) : 'send_failed',
  } satisfies EmailSendResult;
}

async function sendSpecialWinnerEmails(deps: DailyJobDeps, result: SpecialDrawResult) {
  if (!result.event.winner_email_enabled) {
    return { sent: 0, failed: 0, skipped: result.winners.length };
  }

  const replyDeadline = new Date(
    new Date(result.showing.starts_at).getTime()
      - result.event.winner_response_deadline_hours * 60 * 60 * 1000,
  ).toISOString();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const winner of result.winners) {
    if (acceptedWinnerEmailExists(deps.db, winner.applicationId)) {
      skipped += 1;
      continue;
    }

    const input: SpecialWinnerEmailInput = {
      applicationCode: winner.applicationCode,
      fullName: winner.fullName,
      email: winner.email,
      event: {
        slug: result.event.slug,
        title: result.event.title,
        venueName: result.event.venue_name,
      },
      showing: {
        displayLabel: result.showing.display_label,
        startsAt: result.showing.starts_at,
      },
      replyDeadline,
    };
    const emailResult = await sendWinnerEmailWithRetry(deps.emailNotifications, input);
    recordEmailNotification(deps.db, {
      entityType: 'special_application',
      entityId: winner.applicationId,
      template: 'special_draw_winner',
      recipientEmail: winner.email,
      subject: emailResult.subject || `Вы победили в розыгрыше: ${result.event.title}`,
      configurationSetName: deps.postboxConfigurationSetName,
      fingerprintSecret: deps.fingerprintSecret,
      result: emailResult,
    });

    if (emailResult.sent) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return { sent, failed, skipped };
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
      const winnerEmailSummary = await sendSpecialWinnerEmails(deps, result);
      try {
        const text = [
          `Автоматический опубликованный розыгрыш за ${result.event.auto_draw_lead_hours} часов до события.`,
          '',
          `${result.event.title}`,
          `${result.showing.display_label}`,
          `Кандидатов: ${result.totalCandidates}`,
          `Победителей: ${result.winners.length} из ${result.showing.lottery_quota}`,
          `Технических билетиков в барабане: ${result.totalWeight}`,
          `Механика: баллы делятся между выбранными датами; полный аудит в XLSX.`,
          `Источник случайности: ${result.drawMechanism.randomSource}`,
          `Письма победителям: отправлено ${winnerEmailSummary.sent}, пропущено ${winnerEmailSummary.skipped}, ошибок ${winnerEmailSummary.failed}.`,
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
