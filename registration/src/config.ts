import path from 'node:path';

export type AppConfig = {
  operatingMode: 'testing' | 'production';
  host: string;
  port: number;
  appBaseUrl: string;
  publicSiteBaseUrl: string;
  publicTicketBaseUrl: string;
  sqlitePath: string;
  localPublicRoot: string;
  timeZone: string;
  allowedOrigins: string[];
  consentVersion: string;
  consentTextHash: string;
  piiPublicKeyPemBase64: string | null;
  piiPrivateKeyPemBase64: string | null;
  piiFingerprintSecret: string | null;
  telegramBotToken: string | null;
  telegramWebhookSecret: string | null;
  telegramWebhookPath: string;
  emergencyExportToken: string | null;
  ticketsPrefix: string;
  exportsPrefix: string;
  storageDriver: 'local' | 's3';
  s3Bucket: string | null;
  s3Endpoint: string | null;
  s3Region: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  s3ForcePathStyle: boolean;
  vkIdClientId: string | null;
  vkIdClientSecret: string | null;
  vkIdRedirectUri: string;
  vkIdScope: string;
  vkAuthAllowedReturnOrigins: string[];
  vkAuthToken: string | null;
  vkSocialMonitoringEnabled: boolean;
  postboxEnabled: boolean;
  postboxEndpoint: string;
  postboxRegion: string;
  postboxAccessKeyId: string | null;
  postboxSecretAccessKey: string | null;
  postboxFromEmail: string;
  postboxFromName: string | null;
  postboxReplyToEmail: string | null;
  postboxConfigurationSetName: string | null;
  postboxArchiveBccEmail: string | null;
  postboxSendTimeoutMs: number;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, '');
}

function parsePort(value: string | undefined, fallback: number) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function parseOrigins(value: string | undefined, fallback: string) {
  return (value ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(trimTrailingSlash);
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseOperatingMode(value: string | undefined): 'testing' | 'production' {
  return value?.trim().toLowerCase() === 'testing' ? 'testing' : 'production';
}

export function loadConfig(): AppConfig {
  const operatingMode = parseOperatingMode(process.env.REGISTRATION_OPERATING_MODE);
  const host = process.env.HOST?.trim() || '0.0.0.0';
  const port = parsePort(process.env.PORT, 3001);
  const flyAppName = process.env.FLY_APP_NAME?.trim();
  const appBaseUrl = trimTrailingSlash(
    process.env.APP_BASE_URL?.trim()
      || (flyAppName ? `https://${flyAppName}.fly.dev` : `http://localhost:${port}`),
  );
  const publicSiteBaseUrl = trimTrailingSlash(process.env.PUBLIC_SITE_BASE_URL?.trim() || 'http://localhost:4321');
  const publicTicketBaseUrl = trimTrailingSlash(process.env.PUBLIC_TICKET_BASE_URL?.trim() || appBaseUrl);
  const sqlitePath = path.resolve(process.cwd(), process.env.SQLITE_PATH?.trim() || './data/registration.sqlite');
  const localPublicRoot = path.resolve(process.cwd(), process.env.LOCAL_PUBLIC_ROOT?.trim() || './data/public');
  const timeZone = process.env.TZ?.trim() || 'Europe/Kaliningrad';
  const allowedOrigins = parseOrigins(process.env.CORS_ORIGINS, publicSiteBaseUrl);
  const consentVersion = process.env.CONSENT_VERSION?.trim() || 'draft-1';
  const consentTextHash = process.env.CONSENT_TEXT_HASH?.trim() || 'dev-draft';
  const piiPublicKeyPemBase64 = process.env.PII_PUBLIC_KEY_PEM_B64?.trim() || null;
  const piiPrivateKeyPemBase64 = process.env.PII_PRIVATE_KEY_PEM_B64?.trim() || null;
  const piiFingerprintSecret = process.env.PII_FINGERPRINT_SECRET?.trim() || null;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  const telegramWebhookPath = process.env.TELEGRAM_WEBHOOK_PATH?.trim() || '/api/v1/telegram/webhook';
  const emergencyExportToken = process.env.EMERGENCY_EXPORT_TOKEN?.trim() || null;
  const ticketsPrefix = (process.env.TICKETS_PREFIX?.trim() || 'tickets').replace(/^\/+|\/+$/gu, '');
  const exportsPrefix = (process.env.EXPORTS_PREFIX?.trim() || 'exports').replace(/^\/+|\/+$/gu, '');
  const s3Bucket = process.env.S3_BUCKET?.trim() || process.env.YC_BUCKET_NAME?.trim() || null;
  const s3Endpoint = trimTrailingSlash(process.env.S3_ENDPOINT?.trim() || process.env.YC_S3_ENDPOINT?.trim() || '');
  const s3Region = process.env.S3_REGION?.trim() || process.env.YC_REGION?.trim() || null;
  const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID?.trim() || process.env.YC_ACCESS_KEY_ID?.trim() || null;
  const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim() || process.env.YC_SECRET_ACCESS_KEY?.trim() || null;
  const s3ForcePathStyle = parseBoolean(process.env.S3_FORCE_PATH_STYLE, true);
  const storageDriver = s3Bucket && s3Endpoint && s3Region && s3AccessKeyId && s3SecretAccessKey ? 's3' : 'local';
  const vkIdClientId = process.env.VK_ID_CLIENT_ID?.trim() || null;
  const vkIdClientSecret = process.env.VK_ID_CLIENT_SECRET?.trim() || null;
  const vkIdRedirectUri = trimTrailingSlash(
    process.env.VK_ID_REDIRECT_URI?.trim()
      || 'https://api.kgd80.ru/api/v1/auth/vk/callback',
  );
  const vkIdScope = process.env.VK_ID_SCOPE?.trim() || 'vkid.personal_info email phone';
  const vkAuthAllowedReturnOrigins = parseOrigins(
    process.env.VK_AUTH_ALLOWED_RETURN_ORIGINS,
    'https://kgd80.ru,https://www.kgd80.ru,http://localhost:4321,http://127.0.0.1:4321',
  );
  const vkAuthToken = process.env.VK_AUTH_TOKEN?.trim() || null;
  const vkSocialMonitoringEnabled = parseBoolean(process.env.VK_SOCIAL_MONITORING_ENABLED, true);
  const postboxAccessKeyId = process.env.POSTBOX_ACCESS_KEY_ID?.trim() || null;
  const postboxSecretAccessKey = process.env.POSTBOX_SECRET_ACCESS_KEY?.trim() || null;
  const postboxFromEmail = process.env.POSTBOX_FROM_EMAIL?.trim() || 'info@kgd80.ru';
  const postboxFromName = process.env.POSTBOX_FROM_NAME?.trim() || null;
  const postboxReplyToEmail = process.env.POSTBOX_REPLY_TO_EMAIL?.trim() || postboxFromEmail;
  const postboxConfigurationSetName = process.env.POSTBOX_CONFIGURATION_SET_NAME?.trim() || 'kgd80-default';
  const postboxArchiveBccEmail = process.env.POSTBOX_ARCHIVE_BCC_EMAIL?.trim() || null;
  const postboxEnabled = parseBoolean(
    process.env.POSTBOX_ENABLED,
    Boolean(postboxAccessKeyId && postboxSecretAccessKey),
  );
  const postboxSendTimeoutMs = parsePort(process.env.POSTBOX_SEND_TIMEOUT_MS, 15_000);

  return {
    operatingMode,
    host,
    port,
    appBaseUrl,
    publicSiteBaseUrl,
    publicTicketBaseUrl,
    sqlitePath,
    localPublicRoot,
    timeZone,
    allowedOrigins,
    consentVersion,
    consentTextHash,
    piiPublicKeyPemBase64,
    piiPrivateKeyPemBase64,
    piiFingerprintSecret,
    telegramBotToken,
    telegramWebhookSecret,
    telegramWebhookPath,
    emergencyExportToken,
    ticketsPrefix,
    exportsPrefix,
    storageDriver,
    s3Bucket,
    s3Endpoint: s3Endpoint || null,
    s3Region,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3ForcePathStyle,
    vkIdClientId,
    vkIdClientSecret,
    vkIdRedirectUri,
    vkIdScope,
    vkAuthAllowedReturnOrigins,
    vkAuthToken,
    vkSocialMonitoringEnabled,
    postboxEnabled,
    postboxEndpoint: trimTrailingSlash(process.env.POSTBOX_ENDPOINT?.trim() || 'https://postbox.cloud.yandex.net'),
    postboxRegion: process.env.POSTBOX_REGION?.trim() || 'ru-central1',
    postboxAccessKeyId,
    postboxSecretAccessKey,
    postboxFromEmail,
    postboxFromName,
    postboxReplyToEmail,
    postboxConfigurationSetName,
    postboxArchiveBccEmail,
    postboxSendTimeoutMs,
  };
}
