import type Database from 'better-sqlite3';
import type { Bot, GrammyError } from 'grammy';
import { decryptPii } from '../lib/crypto';

type TelegramOutboxPayload =
  | {
      type: 'registration_created';
      registrationId: number;
      eventId: number;
      seatsLeftAfter: number;
    }
  | {
      type: 'special_application_created';
      applicationId: number;
    };

type TelegramOutboxRow = {
  id: number;
  type: string;
  payload_json: string;
  attempt_count: number;
};

type RegistrationNotificationRow = {
  pii_ciphertext: Buffer;
  pii_wrapped_key: Buffer;
  pii_iv: Buffer;
  pii_alg: string;
  title: string;
  starts_at: string;
  capacity: number;
  registration_limit: number;
};

type SpecialApplicationNotificationRow = {
  application_code: string;
  pii_ciphertext: Buffer;
  pii_wrapped_key: Buffer;
  pii_iv: Buffer;
  pii_alg: string;
  title: string;
  format_label: string;
  venue_name: string;
  selected_showing_ids_json: string;
  status: string;
  rejection_reason: string | null;
  uploaded_photo_count: number;
  unique_photo_count: number;
  accepted_photo_count: number;
  stamp_count: number;
  ordinary_registration_count: number;
  no_show_count: number;
  score: number;
};

function formatEventDate(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(isoValue));
}

function computeBackoffSeconds(error: unknown, attemptCount: number) {
  const retryAfter = (error as GrammyError | undefined)?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return retryAfter;
  }

  return Math.min(30 * Math.max(attemptCount, 1), 900);
}

function getSuperadminIds(db: Database.Database) {
  const rows = db.prepare(`
    SELECT telegram_user_id
    FROM telegram_admins
    WHERE role = 'superadmin'
    ORDER BY created_at ASC
  `).all() as Array<{ telegram_user_id: string }>;

  return rows.map((row) => row.telegram_user_id);
}

function loadRegistrationNotification(
  db: Database.Database,
  registrationId: number,
  privateKeyPemBase64: string,
) {
  const row = db.prepare(`
    SELECT
      r.pii_ciphertext,
      r.pii_wrapped_key,
      r.pii_iv,
      r.pii_alg,
      e.title,
      e.starts_at,
      e.capacity,
      e.registration_limit
    FROM registrations r
    INNER JOIN events e ON e.id = r.event_id
    WHERE r.id = ?
    LIMIT 1
  `).get(registrationId) as RegistrationNotificationRow | undefined;

  if (!row) {
    return null;
  }

  let pii: Record<string, string>;

  try {
    pii = decryptPii(privateKeyPemBase64, {
      piiCiphertext: row.pii_ciphertext,
      piiWrappedKey: row.pii_wrapped_key,
      piiIv: row.pii_iv,
      piiAlg: row.pii_alg,
    });
  } catch {
    return null;
  }

  return {
    fullName: pii.fullName,
    title: row.title,
    startsAt: row.starts_at,
    capacity: row.capacity,
    registrationLimit: row.registration_limit,
  };
}

function loadSpecialApplicationNotification(
  db: Database.Database,
  applicationId: number,
  privateKeyPemBase64: string,
) {
  const row = db.prepare(`
    SELECT
      a.application_code,
      a.pii_ciphertext,
      a.pii_wrapped_key,
      a.pii_iv,
      a.pii_alg,
      a.selected_showing_ids_json,
      a.status,
      a.rejection_reason,
      a.uploaded_photo_count,
      a.unique_photo_count,
      a.accepted_photo_count,
      a.stamp_count,
      a.ordinary_registration_count,
      a.no_show_count,
      a.score,
      e.title,
      e.format_label,
      e.venue_name
    FROM special_applications a
    INNER JOIN special_events e ON e.id = a.special_event_id
    WHERE a.id = ?
    LIMIT 1
  `).get(applicationId) as SpecialApplicationNotificationRow | undefined;

  if (!row) {
    return null;
  }

  let pii: Record<string, string>;

  try {
    pii = decryptPii(privateKeyPemBase64, {
      piiCiphertext: row.pii_ciphertext,
      piiWrappedKey: row.pii_wrapped_key,
      piiIv: row.pii_iv,
      piiAlg: row.pii_alg,
    });
  } catch {
    return null;
  }

  let selectedShowingIds: number[];
  try {
    selectedShowingIds = (JSON.parse(row.selected_showing_ids_json) as unknown[])
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  } catch {
    selectedShowingIds = [];
  }

  const showings = selectedShowingIds.length
    ? db.prepare(`
      SELECT display_label
      FROM special_event_showings
      WHERE id IN (${selectedShowingIds.map(() => '?').join(',')})
      ORDER BY starts_at ASC, id ASC
    `).all(...selectedShowingIds) as Array<{ display_label: string }>
    : [];

  return {
    applicationCode: row.application_code,
    fullName: pii.fullName ?? '',
    title: row.title,
    formatLabel: row.format_label,
    venueName: row.venue_name,
    selectedShowings: showings.map((showing) => showing.display_label),
    status: row.status,
    rejectionReason: row.rejection_reason,
    uploadedPhotoCount: row.uploaded_photo_count,
    uniquePhotoCount: row.unique_photo_count,
    acceptedPhotoCount: row.accepted_photo_count,
    stampCount: row.stamp_count,
    ordinaryRegistrationCount: row.ordinary_registration_count,
    noShowCount: row.no_show_count,
    score: row.score,
  };
}

function formatRegistrationCreatedMessage(payload: {
  fullName: string;
  title: string;
  startsAt: string;
  capacity: number;
  registrationLimit: number;
  seatsLeftAfter: number;
}) {
  return [
    'Новая регистрация',
    `ФИО: ${payload.fullName}`,
    `Событие: ${payload.title}`,
    `Дата и время: ${formatEventDate(payload.startsAt)}`,
    `Вместимость зала: ${payload.capacity}`,
    `Квота регистрации: ${payload.registrationLimit}`,
    `Осталось регистрационных мест: ${payload.seatsLeftAfter}`,
  ].join('\n');
}

function formatSpecialApplicationCreatedMessage(payload: {
  applicationCode: string;
  fullName: string;
  title: string;
  formatLabel: string;
  venueName: string;
  selectedShowings: string[];
  status: string;
  rejectionReason: string | null;
  uploadedPhotoCount: number;
  uniquePhotoCount: number;
  acceptedPhotoCount: number;
  stampCount: number;
  ordinaryRegistrationCount: number;
  noShowCount: number;
  score: number;
}) {
  const lines = [
    'Новая заявка на розыгрыш',
    `ФИО: ${payload.fullName}`,
    `Спецмероприятие: ${payload.title}`,
    `Формат и площадка: ${payload.formatLabel}, ${payload.venueName}`,
    `Даты: ${payload.selectedShowings.length ? payload.selectedShowings.join('; ') : 'не указаны'}`,
    `Статус допуска: ${payload.status === 'accepted' ? 'допущена' : 'отклонена'}`,
    payload.rejectionReason ? `Причина: ${payload.rejectionReason}` : null,
    `Штампы: ${payload.stampCount}`,
    `Баллы: ${payload.score}`,
    `Обычных регистраций по ФИО: ${payload.ordinaryRegistrationCount}`,
    `Неявки к штрафу: ${payload.noShowCount}`,
    `Фото: загружено ${payload.uploadedPhotoCount}, уникальных ${payload.uniquePhotoCount}, зачтено ${payload.acceptedPhotoCount}`,
    `Код заявки: ${payload.applicationCode}`,
  ];

  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

export function enqueueRegistrationCreated(
  db: Database.Database,
  payload: {
    registrationId: number;
    eventId: number;
    seatsLeftAfter: number;
  },
) {
  db.prepare(`
    INSERT INTO telegram_outbox(type, payload_json)
    VALUES (?, ?)
  `).run('registration_created', JSON.stringify({
    type: 'registration_created',
    registrationId: payload.registrationId,
    eventId: payload.eventId,
    seatsLeftAfter: payload.seatsLeftAfter,
  } satisfies TelegramOutboxPayload));
}

export function enqueueSpecialApplicationCreated(
  db: Database.Database,
  payload: {
    applicationId: number;
  },
) {
  db.prepare(`
    INSERT INTO telegram_outbox(type, payload_json)
    VALUES (?, ?)
  `).run('special_application_created', JSON.stringify({
    type: 'special_application_created',
    applicationId: payload.applicationId,
  } satisfies TelegramOutboxPayload));
}

export function startTelegramOutboxWorker(options: {
  db: Database.Database;
  bot: Bot;
  logger: { error: (payload: unknown, message?: string) => void };
  privateKeyPemBase64: string;
  intervalMs?: number;
  batchSize?: number;
}) {
  const intervalMs = options.intervalMs ?? 2_000;
  const batchSize = options.batchSize ?? 10;
  let running = false;

  const selectDueRows = options.db.prepare(`
    SELECT id, type, payload_json, attempt_count
    FROM telegram_outbox
    WHERE not_before <= ?
    ORDER BY id ASC
    LIMIT ?
  `);

  const deleteRow = options.db.prepare('DELETE FROM telegram_outbox WHERE id = ?');
  const updateFailure = options.db.prepare(`
    UPDATE telegram_outbox
    SET attempt_count = attempt_count + 1,
        last_error = ?,
        not_before = ?
    WHERE id = ?
  `);

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const rows = selectDueRows.all(new Date().toISOString(), batchSize) as TelegramOutboxRow[];
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json) as TelegramOutboxPayload;

          if (
            (row.type === 'registration_created' && payload.type === 'registration_created')
            || (row.type === 'special_application_created' && payload.type === 'special_application_created')
          ) {
            // handled below
          } else {
            deleteRow.run(row.id);
            continue;
          }

          const superadminIds = getSuperadminIds(options.db);
          if (!superadminIds.length) {
            throw new Error('no_superadmin_registered');
          }

          const text = payload.type === 'registration_created'
            ? (() => {
                const notification = loadRegistrationNotification(
                  options.db,
                  payload.registrationId,
                  options.privateKeyPemBase64,
                );

                if (!notification) {
                  return null;
                }

                return formatRegistrationCreatedMessage({
                  fullName: notification.fullName,
                  title: notification.title,
                  startsAt: notification.startsAt,
                  capacity: notification.capacity,
                  registrationLimit: notification.registrationLimit,
                  seatsLeftAfter: payload.seatsLeftAfter,
                });
              })()
            : (() => {
                const notification = loadSpecialApplicationNotification(
                  options.db,
                  payload.applicationId,
                  options.privateKeyPemBase64,
                );

                if (!notification) {
                  return null;
                }

                return formatSpecialApplicationCreatedMessage(notification);
              })();

          if (!text) {
            deleteRow.run(row.id);
            continue;
          }

          for (const telegramUserId of superadminIds) {
            await options.bot.api.sendMessage(telegramUserId, text);
          }

          deleteRow.run(row.id);
        } catch (error) {
          const delaySeconds = computeBackoffSeconds(error, row.attempt_count + 1);
          const notBefore = new Date(Date.now() + delaySeconds * 1000).toISOString();
          updateFailure.run(error instanceof Error ? error.message : String(error), notBefore, row.id);
        }
      }
    } catch (error) {
      options.logger.error({ err: error }, 'telegram_outbox_tick_failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  timer.unref?.();
  void tick();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
