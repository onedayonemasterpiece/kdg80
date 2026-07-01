import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { runMigrations } from './db/migrate';
import { registerPublicApi } from './api/public';
import { registerRegistrationApi } from './api/registration';
import { registerAdminApi } from './api/admin';
import { registerSpecialApi } from './api/special';
import { registerVkAuthApi } from './api/vk-auth';
import { createStoragePublisher } from './lib/storage';
import { syncCatalog } from './services/catalog';
import { startDailyJobs } from './services/daily-jobs';
import { registerTelegramBot } from './services/telegram-bot';
import { startTelegramOutboxWorker } from './services/telegram-outbox';
import { publishPublicStateManifest } from './services/state-manifest';
import { startVkSocialMonitoring } from './services/vk-social-monitoring';
import { createEmailNotificationService } from './services/email-notifications';

const config = loadConfig();
const db = createDatabase(config.sqlitePath);
const emailNotifications = createEmailNotificationService({
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

if (config.storageDriver === 'local') {
  fs.mkdirSync(config.localPublicRoot, { recursive: true });
}

runMigrations(db);
syncCatalog(db);

const app = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 64 * 1024,
});

async function syncPublicStateManifest(reason: string) {
  try {
    await publishPublicStateManifest(db, storagePublisher);
    app.log.info({ reason }, 'public_state_manifest_published');
    return true;
  } catch (error) {
    app.log.error({ err: error, reason }, 'public_state_manifest_publish_failed');
    return false;
  }
}

const telegramBot = config.telegramBotToken && config.telegramWebhookSecret
  ? registerTelegramBot(app, {
      db,
      token: config.telegramBotToken,
      webhookSecret: config.telegramWebhookSecret,
      appBaseUrl: config.appBaseUrl,
      webhookPath: config.telegramWebhookPath,
      privateKeyPemBase64: config.piiPrivateKeyPemBase64,
      storagePublisher,
      syncPublicStateManifest,
    })
  : null;

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    const normalized = origin.replace(/\/+$/u, '');
    const allowed = config.allowedOrigins.includes(normalized);
    callback(null, allowed);
  },
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
});

await app.register(fastifyStatic, {
  root: path.resolve(process.cwd(), '../assets'),
  prefix: '/shared-assets/',
  decorateReply: false,
});

if (config.storageDriver === 'local') {
  await app.register(fastifyStatic, {
    root: config.localPublicRoot,
    prefix: '/',
    wildcard: true,
    decorateReply: false,
  });
}

app.get('/api/v1/health', async () => {
  return {
    ok: true,
    service: 'registration',
    operatingMode: config.operatingMode,
    appBaseUrl: config.appBaseUrl,
    storageDriver: storagePublisher.driver,
  };
});

await registerPublicApi(app, db);
await registerAdminApi(app, {
  db,
  emergencyExportToken: config.emergencyExportToken,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
});
await registerVkAuthApi(app, {
  db,
  clientId: config.vkIdClientId,
  clientSecret: config.vkIdClientSecret,
  redirectUri: config.vkIdRedirectUri,
  scope: config.vkIdScope,
  allowedReturnOrigins: config.vkAuthAllowedReturnOrigins,
});
await registerSpecialApi(app, {
  db,
  consentVersion: config.consentVersion,
  consentTextHash: config.consentTextHash,
  fingerprintSecret: config.piiFingerprintSecret,
  publicKeyPemBase64: config.piiPublicKeyPemBase64,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
  storagePublisher,
  emailNotifications,
});
await registerRegistrationApi(app, {
  db,
  allowedOrigins: config.allowedOrigins,
  consentVersion: config.consentVersion,
  consentTextHash: config.consentTextHash,
  fingerprintSecret: config.piiFingerprintSecret,
  publicKeyPemBase64: config.piiPublicKeyPemBase64,
  publicTicketBaseUrl: config.publicTicketBaseUrl,
  ticketsPrefix: config.ticketsPrefix,
  storagePublisher,
  syncPublicStateManifest,
  emailNotifications,
});

await syncPublicStateManifest('startup');

if (config.vkSocialMonitoringEnabled) {
  startVkSocialMonitoring({
    db,
    token: config.vkAuthToken,
    privateKeyPemBase64: config.piiPrivateKeyPemBase64,
    logger: app.log,
    timeZone: config.timeZone,
    bot: telegramBot?.bot,
  });
}

await app.listen({
  host: config.host,
  port: config.port,
});

app.log.info({ operatingMode: config.operatingMode }, 'registration_operating_mode');

if (telegramBot) {
  await telegramBot.ensureWebhook();
  startDailyJobs({
    db,
    bot: telegramBot.bot,
    logger: app.log,
    privateKeyPemBase64: config.piiPrivateKeyPemBase64,
    timeZone: config.timeZone,
    syncPublicStateManifest,
  });

  if (config.piiPrivateKeyPemBase64) {
    startTelegramOutboxWorker({
      db,
      bot: telegramBot.bot,
      logger: app.log,
      privateKeyPemBase64: config.piiPrivateKeyPemBase64,
    });
  }
}
