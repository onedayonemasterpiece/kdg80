import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { sendVkSocialPersonalReports } from '../src/services/vk-social-monitoring';

const config = loadConfig();

if (!config.vkAuthToken) {
  throw new Error('VK_AUTH_TOKEN is required.');
}
if (!config.piiPrivateKeyPemBase64) {
  throw new Error('PII_PRIVATE_KEY_PEM_B64 is required.');
}

const db = createDatabase(config.sqlitePath);
runMigrations(db);

const summary = await sendVkSocialPersonalReports({
  db,
  token: config.vkAuthToken,
  privateKeyPemBase64: config.piiPrivateKeyPemBase64,
  runId: null,
  logger: console as never,
});

console.log(JSON.stringify(summary, null, 2));
