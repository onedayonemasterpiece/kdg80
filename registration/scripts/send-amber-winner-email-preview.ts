import { loadConfig } from '../src/config';
import { createEmailNotificationService } from '../src/services/email-notifications';

const config = loadConfig();
const target = process.env.AMBER_WINNER_PREVIEW_EMAIL?.trim() || 'info@kgd80.ru';
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
  applicationCode: 'ПРОЕКТ-ДЛЯ-СОГЛАСОВАНИЯ',
  fullName: 'Максим',
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
  previewMode: true,
});

if (!result.sent) {
  throw new Error(`Preview email was not sent: ${result.reason || 'unknown reason'}`);
}

console.log(JSON.stringify({
  sent: result.sent,
  messageId: result.messageId,
  subject: result.subject,
  target,
}));
