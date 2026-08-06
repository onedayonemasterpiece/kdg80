import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptPii } from '../lib/crypto';
import type { StoragePublisher } from '../lib/storage';

const CLEANUP_PURPOSE = 'special-test-application-cleanup:v1';

type TestApplicationRow = {
  id: number;
  application_code: string;
  participant_profile_id: number | null;
  pii_ciphertext: Buffer;
  pii_wrapped_key: Buffer;
  pii_iv: Buffer;
  pii_alg: string;
};

export class SpecialTestCleanupError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isSpecialTestFullName(value: unknown) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleUpperCase('ru-RU');
  return normalized === 'ТЕСТ'
    || normalized.startsWith('ТЕСТ ')
    || normalized === 'TEST'
    || normalized.startsWith('TEST ');
}

export function createSpecialTestCleanupToken(secret: string, applicationCode: string) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${CLEANUP_PURPOSE}:${applicationCode}`)
    .digest('base64url');
}

export function verifySpecialTestCleanupToken(
  secret: string,
  applicationCode: string,
  suppliedToken: unknown,
) {
  const expected = Buffer.from(createSpecialTestCleanupToken(secret, applicationCode));
  const received = Buffer.from(String(suppliedToken ?? '').trim());
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export async function cleanupSpecialTestApplication(
  db: Database.Database,
  options: {
    applicationCode: string;
    privateKeyPemBase64: string;
    storagePublisher: StoragePublisher;
  },
) {
  const applicationCode = options.applicationCode.trim();
  if (!applicationCode.startsWith('TEST-')) {
    throw new SpecialTestCleanupError(
      403,
      'not_a_test_application_code',
      'Удаление разрешено только для заявок с техническим кодом TEST-.',
    );
  }

  const row = db.prepare(`
    SELECT
      id,
      application_code,
      participant_profile_id,
      pii_ciphertext,
      pii_wrapped_key,
      pii_iv,
      pii_alg
    FROM special_applications
    WHERE application_code = ?
    LIMIT 1
  `).get(applicationCode) as TestApplicationRow | undefined;

  if (!row) {
    return null;
  }

  let pii: Record<string, string>;
  try {
    pii = decryptPii(options.privateKeyPemBase64, {
      piiCiphertext: row.pii_ciphertext,
      piiWrappedKey: row.pii_wrapped_key,
      piiIv: row.pii_iv,
      piiAlg: row.pii_alg,
    });
  } catch {
    throw new SpecialTestCleanupError(
      500,
      'test_application_pii_decrypt_failed',
      'Не удалось безопасно проверить тестовую заявку перед удалением.',
    );
  }

  if (!isSpecialTestFullName(pii.fullName)) {
    throw new SpecialTestCleanupError(
      403,
      'not_a_test_application',
      'Удаление разрешено только для заявок, где ФИО начинается с «ТЕСТ» или «TEST».',
    );
  }

  const photoRows = db.prepare(`
    SELECT storage_key
    FROM special_application_photos
    WHERE application_id = ?
    ORDER BY id ASC
  `).all(row.id) as Array<{ storage_key: string }>;

  const failedStorageKeys: string[] = [];
  for (const photo of photoRows) {
    try {
      await options.storagePublisher.deletePrivateAsset(photo.storage_key);
    } catch {
      failedStorageKeys.push(photo.storage_key);
    }
  }

  if (failedStorageKeys.length) {
    throw new SpecialTestCleanupError(
      502,
      'test_private_asset_cleanup_failed',
      `Не удалось удалить ${failedStorageKeys.length} приватных файлов тестовой заявки.`,
    );
  }

  const remove = db.transaction(() => {
    const notificationRows = db.prepare(`
      SELECT id
      FROM email_notifications
      WHERE entity_type = 'special_application' AND entity_id = ?
    `).all(row.id) as Array<{ id: number }>;
    const notificationIds = notificationRows.map((item) => item.id);

    let removedEmailEvents = 0;
    if (notificationIds.length) {
      const placeholders = notificationIds.map(() => '?').join(', ');
      removedEmailEvents = db.prepare(`
        DELETE FROM email_notification_events
        WHERE notification_id IN (${placeholders})
      `).run(...notificationIds).changes;
    }

    const removedEmailNotifications = db.prepare(`
      DELETE FROM email_notifications
      WHERE entity_type = 'special_application' AND entity_id = ?
    `).run(row.id).changes;

    const removedTelegramOutboxRows = db.prepare(`
      DELETE FROM telegram_outbox
      WHERE type = 'special_application_created'
        AND payload_json LIKE ?
    `).run(`%\"applicationId\":${row.id}%`).changes;

    const removedApplication = db.prepare(`
      DELETE FROM special_applications
      WHERE id = ? AND application_code = ?
    `).run(row.id, row.application_code).changes;

    let removedProfile = 0;
    if (row.participant_profile_id) {
      removedProfile = db.prepare(`
        DELETE FROM special_participant_profiles
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM special_applications
            WHERE participant_profile_id = ?
          )
      `).run(row.participant_profile_id, row.participant_profile_id).changes;
    }

    return {
      removedApplication,
      removedProfile,
      removedTelegramOutboxRows,
      removedEmailNotifications,
      removedEmailEvents,
    };
  });

  const removed = remove();
  if (removed.removedApplication !== 1) {
    throw new SpecialTestCleanupError(
      409,
      'test_application_cleanup_race',
      'Тестовая заявка уже была изменена или удалена. Проверьте состояние ещё раз.',
    );
  }

  return {
    applicationCode: row.application_code,
    removedPrivateAssets: photoRows.length,
    ...removed,
  };
}
