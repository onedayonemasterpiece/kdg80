import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { createStoragePublisher } from '../src/lib/storage';
import { createEmailNotificationService } from '../src/services/email-notifications';
import { cleanupSpecialTestApplication } from '../src/services/special-test-cleanup';

const config = loadConfig();
const target = process.env.AMBER_WINNER_PREVIEW_EMAIL?.trim() || 'info@kgd80.ru';
const applicationCode = process.env.AMBER_WINNER_APPLICATION_CODE?.trim() || 'AMBER-2026-001';
const fullName = process.env.AMBER_WINNER_FULL_NAME?.trim() || 'Максим';
const service = createEmailNotificationService({
  enabled: config.postboxEnabled,
  endpoint: config.postboxEndpoint,
  region: config.postboxRegion,
  accessKeyId: config.postboxAccessKeyId,
  secretAccessKey: config.postboxSecretAccessKey,
  fromEmail: config.postboxFromEmail,
  fromName: config.postboxFromName,
  replyToEmail: config.postboxReplyToEmail,
  configurationSetName: config.postboxConfigurationSetName,
  archiveBccEmail: config.postboxArchiveBccEmail,
  timeZone: config.timeZone,
  sendTimeoutMs: config.postboxSendTimeoutMs,
});

const result = await service.sendSpecialWinner({
  applicationCode,
  fullName,
  email: target,
  event: {
    slug: 'amber-combine-jewelry-excursion',
    title: 'Экскурсия на ювелирное производство Калининградского янтарного комбината',
    venueName: 'Калининградский янтарный комбинат, посёлок Янтарный',
  },
  showing: {
    displayLabel: '11 августа 11:00 · ювелирное производство Янтарного комбината',
    startsAt: '2026-08-11T11:00:00+02:00',
  },
  replyDeadline: '2026-08-10T11:00:00+02:00',
});

if (!result.sent) {
  throw new Error(`Winner email was not sent: ${result.reason || 'unknown reason'}`);
}

let cleanup: Awaited<ReturnType<typeof cleanupSpecialTestApplication>> | null = null;
if (applicationCode.startsWith('TEST-AMBER-MAIL-')) {
  if (!config.piiPrivateKeyPemBase64) {
    throw new Error('PII_PRIVATE_KEY_PEM_B64 is required to clean the TEST registration.');
  }

  const db = createDatabase(config.sqlitePath);
  runMigrations(db);
  const storagePublisher = createStoragePublisher({
    driver: config.storageDriver,
    publicTicketBaseUrl: config.publicTicketBaseUrl,
    ticketsPrefix: config.ticketsPrefix,
    localPublicRoot: config.localPublicRoot,
    s3Bucket: config.s3Bucket,
    s3Endpoint: config.s3Endpoint,
    s3Region: config.s3Region,
    s3AccessKeyId: config.s3AccessKeyId,
    s3SecretAccessKey: config.s3SecretAccessKey,
    s3ForcePathStyle: config.s3ForcePathStyle,
  });

  try {
    cleanup = await cleanupSpecialTestApplication(db, {
      applicationCode,
      privateKeyPemBase64: config.piiPrivateKeyPemBase64,
      storagePublisher,
    });
  } finally {
    db.close();
  }

  if (!cleanup || cleanup.removedApplication !== 1) {
    throw new Error(`TEST registration cleanup failed: ${applicationCode}`);
  }
}

console.log(JSON.stringify({
  sent: result.sent,
  messageId: result.messageId,
  subject: result.subject,
  target,
  applicationCode,
  cleanup: cleanup ? {
    removedApplication: cleanup.removedApplication,
    removedProfile: cleanup.removedProfile,
    removedPrivateAssets: cleanup.removedPrivateAssets,
    removedTelegramOutboxRows: cleanup.removedTelegramOutboxRows,
    removedEmailNotifications: cleanup.removedEmailNotifications,
    removedEmailEvents: cleanup.removedEmailEvents,
  } : null,
}));
