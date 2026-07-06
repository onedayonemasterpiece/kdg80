import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { createEmailNotificationService } from '../src/services/email-notifications';
import { sendSpecialSocialActivityReminders } from '../src/services/special-social-reminders';

const args = process.argv.slice(2);
const hasArg = (name: string) => args.includes(name);
const valueArg = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = !hasArg('--send');
const limit = Number(valueArg('--limit') ?? 100);
const inactiveDays = Number(valueArg('--inactive-days') ?? 5);
const config = loadConfig();

if (!config.piiPrivateKeyPemBase64) {
  throw new Error('PII_PRIVATE_KEY_PEM_B64 is required.');
}

const db = createDatabase(config.sqlitePath);
runMigrations(db);

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

const summary = await sendSpecialSocialActivityReminders(db, {
  emailNotifications,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
  fingerprintSecret: config.piiFingerprintSecret,
  postboxConfigurationSetName: config.postboxConfigurationSetName,
  dryRun,
  inactiveDays,
  limit: Number.isFinite(limit) ? limit : 100,
});

console.log(JSON.stringify({
  ...summary,
  sender: config.postboxFromEmail,
  replyTo: config.postboxReplyToEmail,
  archiveBccEnabled: Boolean(config.postboxArchiveBccEmail),
}, null, 2));
