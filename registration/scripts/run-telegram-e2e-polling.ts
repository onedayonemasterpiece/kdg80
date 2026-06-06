import Fastify from 'fastify';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createStoragePublisher } from '../src/lib/storage.js';
import { syncCatalog } from '../src/services/catalog.js';
import { publishPublicStateManifest } from '../src/services/state-manifest.js';
import { registerTelegramBot } from '../src/services/telegram-bot.js';
import { startTelegramOutboxWorker } from '../src/services/telegram-outbox.js';

const config = loadConfig();

if (!config.telegramBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required for Telegram E2E polling.');
}

if (process.env.TELEGRAM_E2E_ALLOW_DELETE_WEBHOOK !== '1') {
  throw new Error('Set TELEGRAM_E2E_ALLOW_DELETE_WEBHOOK=1 to run polling and delete the current webhook.');
}

const db = createDatabase(config.sqlitePath);
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

const app = Fastify({ logger: true });

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

const registered = registerTelegramBot(app, {
  db,
  token: config.telegramBotToken,
  webhookSecret: config.telegramWebhookSecret ?? 'e2e-local-webhook-secret',
  appBaseUrl: config.appBaseUrl,
  webhookPath: config.telegramWebhookPath,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
  storagePublisher,
  syncPublicStateManifest,
  skipWebhook: true,
});

const botInfo = await registered.bot.api.getMe();
app.log.info({ username: botInfo.username }, 'telegram_e2e_polling_bot');

await registered.bot.api.deleteWebhook({ drop_pending_updates: true });
app.log.info('telegram_e2e_webhook_deleted');

const outboxWorker = config.piiPrivateKeyPemBase64
  ? startTelegramOutboxWorker({
      db,
      bot: registered.bot,
      logger: app.log,
      privateKeyPemBase64: config.piiPrivateKeyPemBase64,
    })
  : null;

const stopPolling = registered.bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: (info) => {
    app.log.info({ username: info.username }, 'telegram_e2e_polling_started');
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'telegram_e2e_polling_stopping');
    outboxWorker?.stop();
    registered.bot.stop(signal);
  });
}

await stopPolling;
