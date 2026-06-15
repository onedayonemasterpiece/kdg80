import { Bot } from 'grammy';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { syncCatalog } from '../src/services/catalog';
import { runVkSocialMonitoring } from '../src/services/vk-social-monitoring';

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--write');
const sendTelegram = args.has('--telegram');
const config = loadConfig();

if (!config.vkAuthToken) {
  throw new Error('VK_AUTH_TOKEN is required for VK social sync');
}

if (!config.piiPrivateKeyPemBase64) {
  throw new Error('PII_PRIVATE_KEY_PEM_B64 is required to match special application names');
}

const bot = sendTelegram && config.telegramBotToken ? new Bot(config.telegramBotToken) : undefined;
if (sendTelegram && !bot) {
  throw new Error('TELEGRAM_BOT_TOKEN is required for --telegram report delivery');
}

const db = createDatabase(config.sqlitePath);
if (!dryRun) {
  runMigrations(db);
  syncCatalog(db);
}

const result = await runVkSocialMonitoring({
  db,
  token: config.vkAuthToken,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
  dryRun,
  trigger: dryRun ? 'dry_run' : 'manual',
  bot,
  sendTelegramReport: sendTelegram,
  reportHours: 24,
});

const byStatus = result.actors.reduce<Record<string, number>>((acc, actor) => {
  acc[actor.match.status] = (acc[actor.match.status] ?? 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  runKey: result.runKey,
  dryRun: result.dryRun,
  notificationsCount: result.notificationsCount,
  wallPostCount: result.wallPostCount,
  activityCount: result.activityCount,
  actorCount: result.actorCount,
  llmRequestCount: result.llmRequestCount,
  telegramReportSent: result.telegramReportSent,
  byStatus,
}, null, 2));
