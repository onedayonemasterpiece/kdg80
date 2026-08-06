import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createStoragePublisher } from '../src/lib/storage.js';
import { cleanupSpecialTestApplication } from '../src/services/special-test-cleanup.js';

const applicationCode = process.env.AMBER_TEST_APPLICATION_CODE?.trim() || '';
if (!applicationCode.startsWith('TEST-AMBER-MAIL-')) {
  throw new Error('AMBER_TEST_APPLICATION_CODE must start with TEST-AMBER-MAIL-.');
}

const config = loadConfig();
if (!config.piiPrivateKeyPemBase64) {
  throw new Error('PII_PRIVATE_KEY_PEM_B64 is required.');
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
  const result = await cleanupSpecialTestApplication(db, {
    applicationCode,
    privateKeyPemBase64: config.piiPrivateKeyPemBase64,
    storagePublisher,
  });

  if (!result) {
    throw new Error(`TEST application not found: ${applicationCode}`);
  }

  console.log(JSON.stringify({
    cleaned: true,
    applicationCode: result.applicationCode,
    removedApplication: result.removedApplication,
    removedProfile: result.removedProfile,
    removedPrivateAssets: result.removedPrivateAssets,
    removedTelegramOutboxRows: result.removedTelegramOutboxRows,
    removedEmailNotifications: result.removedEmailNotifications,
    removedEmailEvents: result.removedEmailEvents,
  }));
} finally {
  db.close();
}
