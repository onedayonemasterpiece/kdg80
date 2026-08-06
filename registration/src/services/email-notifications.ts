import crypto from 'node:crypto';

export type PostboxConfig = {
  enabled: boolean;
  endpoint: string;
  region: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
  configurationSetName: string | null;
  archiveBccEmail: string | null;
  timeZone: string;
  sendTimeoutMs: number;
};

export type EmailSendResult = {
  sent: boolean;
  provider: 'yandex-postbox';
  messageId: string | null;
  reason?: string;
  subject?: string;
};

export type EmailNotificationService = {
  sendRegistrationCreated(input: RegistrationEmailInput): Promise<EmailSendResult>;
  sendSpecialApplicationCreated(input: SpecialApplicationEmailInput): Promise<EmailSendResult>;
  sendSpecialWinner(input: SpecialWinnerEmailInput): Promise<EmailSendResult>;
  sendSpecialSocialActivityReminder(input: SpecialSocialActivityReminderEmailInput): Promise<EmailSendResult>;
};

export type RegistrationEmailInput = {
  eventSlug: string;
  eventTitle: string;
  startsAt: string;
  venueName: string;
  hallName: string | null;
  address: string;
  fullName: string;
  email: string;
  shortTicketId: string;
  ticketUrl: string;
  pdfUrl: string;
  icsUrl: string;
  publicDetailsDeferred?: boolean;
};

export type SpecialApplicationEmailInput = {
  applicationCode: string;
  status: 'accepted' | 'rejected';
  rejectionReason: string | null;
  event: {
    slug: string;
    title: string;
    venueName: string;
  };
  selectedShowings: Array<{
    slug: string;
    displayLabel: string;
    startsAt: string;
  }>;
  scoring: {
    stampCount: number;
    score: number;
  };
  fullName: string;
  email: string;
};

export type SpecialWinnerEmailInput = {
  applicationCode: string;
  fullName: string;
  email: string;
  event: {
    slug: string;
    title: string;
    venueName: string;
  };
  showing: {
    displayLabel: string;
    startsAt: string;
  };
  replyDeadline: string;
  previewMode?: boolean;
};

export type SpecialSocialActivityReminderEmailInput = {
  applicationCode: string;
  fullName: string;
  email: string;
  event: {
    title: string;
    venueName: string;
  };
  showing: {
    displayLabel: string;
    startsAt: string;
  };
  social: {
    bonusPoints: number;
    latestActivityAt: string | null;
    inactiveDays: number;
  };
};

const FOOTER_LINES = [
  'Фестиваль',
  '«80 историй о главном»',
  'к 80-летию Калининградской области',
  'Российское общество «Знание»',
];

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/u, '');
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function awsDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function signingKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function formatFrom(config: PostboxConfig) {
  if (!config.fromName) {
    return config.fromEmail;
  }

  const escapedName = config.fromName.replace(/(["\\])/gu, '\\$1');
  return `"${escapedName}" <${config.fromEmail}>`;
}

function formatDateTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function footerText() {
  return FOOTER_LINES.join('\n');
}

function footerHtml() {
  return FOOTER_LINES.map(escapeHtml).join('<br>');
}

function paragraphsHtml(lines: string[]) {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
}

export function renderRegistrationEmail(input: RegistrationEmailInput, timeZone: string) {
  const startsAt = input.publicDetailsDeferred ? '' : formatDateTime(input.startsAt, timeZone);
  const place = input.publicDetailsDeferred
    ? ''
    : [input.venueName, input.hallName, input.address].filter(Boolean).join(', ');
  const detailsLines = input.publicDetailsDeferred
    ? ['Дата и место будут опубликованы позже.']
    : [`Дата и время: ${startsAt}.`, `Место: ${place}.`];
  const subject = `Вы зарегистрированы: ${input.eventTitle}`;
  const text = [
    `Здравствуйте, ${input.fullName}!`,
    '',
    `Вы зарегистрированы на событие «${input.eventTitle}».`,
    ...detailsLines,
    '',
    `Ваш номер приглашения: ${input.shortTicketId}.`,
    `Приглашение: ${input.ticketUrl}`,
    `PDF: ${input.pdfUrl}`,
    ...(input.publicDetailsDeferred ? [] : [`Календарь: ${input.icsUrl}`]),
    '',
    'Если планы изменятся или возникнут вопросы, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.',
    '',
    footerText(),
  ].join('\n');
  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f7f1e8;color:#12110e;font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
  <main style="max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;padding:28px;border:1px solid #eadfce;">
    <h1 style="margin:0 0 18px;font-size:24px;line-height:1.2;">${escapeHtml('Вы зарегистрированы')}</h1>
    ${paragraphsHtml([
      `Здравствуйте, ${input.fullName}!`,
      `Вы зарегистрированы на событие «${input.eventTitle}».`,
      ...detailsLines,
      `Ваш номер приглашения: ${input.shortTicketId}.`,
    ])}
    <p><a href="${escapeHtml(input.ticketUrl)}" style="color:#b83f2f;font-weight:bold;">Открыть приглашение</a></p>
    <p style="font-size:14px;color:#554f48;">PDF: <a href="${escapeHtml(input.pdfUrl)}">${escapeHtml(input.pdfUrl)}</a>${input.publicDetailsDeferred ? '' : `<br>Календарь: <a href="${escapeHtml(input.icsUrl)}">${escapeHtml(input.icsUrl)}</a>`}</p>
    <p>Если планы изменятся или возникнут вопросы, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.</p>
    <hr style="border:0;border-top:1px solid #eadfce;margin:24px 0;">
    <p style="margin:0;color:#554f48;">${footerHtml()}</p>
  </main>
</body>
</html>`;

  return { subject, text, html };
}

export function renderSpecialApplicationEmail(input: SpecialApplicationEmailInput, timeZone: string) {
  const statusText = input.status === 'accepted'
    ? 'Заявка принята и участвует в розыгрыше.'
    : 'Заявка получена, но пока не участвует в розыгрыше.';
  const selectedShowingsText = input.selectedShowings
    .map((showing) => `${showing.displayLabel} (${formatDateTime(showing.startsAt, timeZone)})`)
    .join('; ');
  const subject = `Заявка на спецмероприятие: ${input.event.title}`;
  const rejectionLine = input.status === 'rejected' && input.rejectionReason
    ? `Причина: ${input.rejectionReason}`
    : null;
  const text = [
    `Здравствуйте, ${input.fullName}!`,
    '',
    `Мы получили вашу заявку на спецмероприятие «${input.event.title}».`,
    statusText,
    `Код заявки: ${input.applicationCode}.`,
    `Выбранные даты: ${selectedShowingsText}.`,
    `Распознано штампов: ${input.scoring.stampCount}. Баллы для розыгрыша: ${input.scoring.score}.`,
    rejectionLine,
    '',
    'Если нужно уточнить данные или задать вопрос, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.',
    '',
    footerText(),
  ].filter((line): line is string => line !== null).join('\n');
  const htmlLines = [
    `Здравствуйте, ${input.fullName}!`,
    `Мы получили вашу заявку на спецмероприятие «${input.event.title}».`,
    statusText,
    `Код заявки: ${input.applicationCode}.`,
    `Выбранные даты: ${selectedShowingsText}.`,
    `Распознано штампов: ${input.scoring.stampCount}. Баллы для розыгрыша: ${input.scoring.score}.`,
    rejectionLine,
    'Если нужно уточнить данные или задать вопрос, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.',
  ].filter((line): line is string => line !== null);
  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f7f1e8;color:#12110e;font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
  <main style="max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;padding:28px;border:1px solid #eadfce;">
    <h1 style="margin:0 0 18px;font-size:24px;line-height:1.2;">${escapeHtml('Заявка на спецмероприятие получена')}</h1>
    ${paragraphsHtml(htmlLines)}
    <hr style="border:0;border-top:1px solid #eadfce;margin:24px 0;">
    <p style="margin:0;color:#554f48;">${footerHtml()}</p>
  </main>
</body>
</html>`;

  return { subject, text, html };
}

export function renderSpecialWinnerEmail(input: SpecialWinnerEmailInput, timeZone: string) {
  const startsAt = formatDateTime(input.showing.startsAt, timeZone);
  const replyDeadline = formatDateTime(input.replyDeadline, timeZone);
  const subject = `${input.previewMode ? '[ПРОЕКТ ДЛЯ СОГЛАСОВАНИЯ] ' : ''}Вы победили в розыгрыше: ${input.event.title}`;
  const heroImageUrl = input.event.slug === 'amber-combine-jewelry-excursion'
    ? 'https://znanie-kgd80-fest.fly.dev/shared-assets/email/amber-combine-jewelry-production.png'
    : null;
  const consentLine = 'Отправляя паспортные данные ответным письмом, вы подтверждаете согласие на их обработку и передачу Калининградскому янтарному комбинату исключительно для оформления разового пропуска на эту экскурсию.';
  const text = [
    `Здравствуйте, ${input.fullName}!`,
    '',
    `Вы стали победителем розыгрыша на спецмероприятие «${input.event.title}».`,
    `Дата и время: ${startsAt}.`,
    `Площадка: ${input.event.venueName}.`,
    '',
    `Ответьте на это письмо не позднее ${replyDeadline} и укажите:`,
    '1. Полное ФИО.',
    '2. Серию и номер паспорта гражданина Российской Федерации.',
    '',
    'К участию допускаются только граждане Российской Федерации.',
    'Фотографию или скан паспорта отправлять не нужно.',
    consentLine,
    '',
    'Если данные не будут получены в указанный срок, организатор вправе передать место другому участнику.',
    'Точную точку сбора и требования пропускного режима мы направим дополнительно после оформления списка участников.',
    '',
    `Код заявки: ${input.applicationCode}.`,
    '',
    footerText(),
  ].join('\n');
  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f7f1e8;color:#12110e;font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
  <main style="max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;overflow:hidden;border:1px solid #eadfce;">
    ${heroImageUrl ? `<img src="${escapeHtml(heroImageUrl)}" width="640" alt="Ювелирное производство Калининградского янтарного комбината" style="display:block;width:100%;height:auto;border:0;">` : ''}
    <section style="padding:28px;">
    ${input.previewMode ? '<div style="margin:0 0 18px;padding:10px 12px;border-radius:10px;background:#172434;color:#ffffff;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;">Проект для согласования · это письмо ещё не отправляется победителям</div>' : ''}
    <p style="margin:0 0 10px;color:#9f3429;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;">Победа в розыгрыше</p>
    <h1 style="margin:0 0 18px;font-size:25px;line-height:1.2;">${escapeHtml(input.event.title)}</h1>
    ${paragraphsHtml([
      `Здравствуйте, ${input.fullName}!`,
      `Вы стали победителем розыгрыша. Дата и время: ${startsAt}.`,
      `Площадка: ${input.event.venueName}.`,
      `Ответьте на это письмо не позднее ${replyDeadline}.`,
    ])}
    <div style="margin:20px 0;padding:18px;border-radius:14px;background:#f3e5d4;border:1px solid #dfc8ae;">
      <strong>В ответном письме укажите:</strong>
      <ol style="margin:10px 0 0;padding-left:22px;">
        <li>полное ФИО;</li>
        <li>серию и номер паспорта гражданина Российской Федерации.</li>
      </ol>
    </div>
    ${paragraphsHtml([
      'К участию допускаются только граждане Российской Федерации.',
      'Фотографию или скан паспорта отправлять не нужно.',
      consentLine,
      'Если данные не будут получены в указанный срок, организатор вправе передать место другому участнику.',
      'Точную точку сбора и требования пропускного режима мы направим дополнительно после оформления списка участников.',
      `Код заявки: ${input.applicationCode}.`,
    ])}
    <hr style="border:0;border-top:1px solid #eadfce;margin:24px 0;">
    <p style="margin:0;color:#554f48;">${footerHtml()}</p>
    </section>
  </main>
</body>
</html>`;

  return { subject, text, html };
}

export function renderSpecialSocialActivityReminderEmail(
  input: SpecialSocialActivityReminderEmailInput,
  timeZone: string,
) {
  const startsAt = formatDateTime(input.showing.startsAt, timeZone);
  const subject = `Соцбаллы к розыгрышу: ${input.event.title}`;
  const lastActivityLine = input.social.latestActivityAt
    ? `Последняя учтённая VK-активность по вашей заявке была ${formatDateTime(input.social.latestActivityAt, timeZone)}.`
    : 'Пока мы не видим VK-активности, связанной с вашей заявкой.';
  const currentBonusLine = input.social.bonusPoints > 0
    ? `Сейчас у вас уже есть ${input.social.bonusPoints} соцбалл(ов), и их можно увеличить.`
    : 'Сейчас по VK-активности ещё нет дополнительных соцбаллов.';
  const text = [
    `Здравствуйте, ${input.fullName}!`,
    '',
    `Вы участвуете в розыгрыше на спецмероприятие «${input.event.title}».`,
    `Розыгрыш относится к будущему показу: ${input.showing.displayLabel} (${startsAt}).`,
    `Код заявки: ${input.applicationCode}.`,
    '',
    `Мы не видим новой VK-соцактивности по вашей заявке последние ${input.social.inactiveDays} дней.`,
    lastActivityLine,
    currentBonusLine,
    '',
    'Лайки, комментарии и репосты постов фестиваля ВКонтакте помогают большему числу жителей увидеть события фестиваля. За такую активность начисляются дополнительные соцбаллы, которые прибавляются к вашим баллам и увеличивают вес участия именно в этом розыгрыше.',
    'Комментарии и репосты обычно дают больше веса, регулярные лайки тоже учитываются.',
    '',
    'Если у вас есть VK-профиль, проявите активность в пабликах фестиваля: поставьте лайк, оставьте комментарий или сделайте репост актуального поста — после следующей проверки мы учтём подходящие действия.',
    '',
    'Если нужно уточнить данные или задать вопрос, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.',
    '',
    footerText(),
  ].join('\n');
  const htmlLines = [
    `Здравствуйте, ${input.fullName}!`,
    `Вы участвуете в розыгрыше на спецмероприятие «${input.event.title}».`,
    `Розыгрыш относится к будущему показу: ${input.showing.displayLabel} (${startsAt}).`,
    `Код заявки: ${input.applicationCode}.`,
    `Мы не видим новой VK-соцактивности по вашей заявке последние ${input.social.inactiveDays} дней.`,
    lastActivityLine,
    currentBonusLine,
    'Лайки, комментарии и репосты постов фестиваля ВКонтакте помогают большему числу жителей увидеть события фестиваля. За такую активность начисляются дополнительные соцбаллы, которые прибавляются к вашим баллам и увеличивают вес участия именно в этом розыгрыше.',
    'Комментарии и репосты обычно дают больше веса, регулярные лайки тоже учитываются.',
    'Если у вас есть VK-профиль, проявите активность в пабликах фестиваля: поставьте лайк, оставьте комментарий или сделайте репост актуального поста — после следующей проверки мы учтём подходящие действия.',
    'Если нужно уточнить данные или задать вопрос, ответьте на это письмо — мы получим ваш ответ в info@kgd80.ru.',
  ];
  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f7f1e8;color:#12110e;font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
  <main style="max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;padding:28px;border:1px solid #eadfce;">
    <h1 style="margin:0 0 18px;font-size:24px;line-height:1.2;">${escapeHtml('Как добавить соцбаллы к розыгрышу')}</h1>
    ${paragraphsHtml(htmlLines)}
    <hr style="border:0;border-top:1px solid #eadfce;margin:24px 0;">
    <p style="margin:0;color:#554f48;">${footerHtml()}</p>
  </main>
</body>
</html>`;

  return { subject, text, html };
}

async function sendPostboxEmail(config: PostboxConfig, message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  if (!config.enabled) {
    return {
      sent: false,
      provider: 'yandex-postbox' as const,
      messageId: null,
      reason: 'email_notifications_disabled',
      subject: message.subject,
    };
  }

  if (!config.accessKeyId || !config.secretAccessKey) {
    return {
      sent: false,
      provider: 'yandex-postbox' as const,
      messageId: null,
      reason: 'postbox_credentials_missing',
      subject: message.subject,
    };
  }

  const endpoint = normalizeEndpoint(config.endpoint);
  const url = new URL('/v2/email/outbound-emails', endpoint);
  const destination: Record<string, string[]> = {
    ToAddresses: [message.to],
  };
  if (config.archiveBccEmail) {
    destination.BccAddresses = [config.archiveBccEmail];
  }

  const payload: Record<string, unknown> = {
    FromEmailAddress: formatFrom(config),
    Destination: destination,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: message.text, Charset: 'UTF-8' },
          Html: { Data: message.html, Charset: 'UTF-8' },
        },
      },
    },
  };
  if (config.configurationSetName) {
    payload.ConfigurationSetName = config.configurationSetName;
  }
  if (config.replyToEmail) {
    payload.ReplyToAddresses = [config.replyToEmail];
  }

  const body = JSON.stringify(payload);
  const bodyHash = sha256Hex(body);
  const { amzDate, dateStamp } = awsDate();
  const service = 'ses';
  const canonicalUri = url.pathname;
  const canonicalQuery = '';
  const canonicalHeaders = [
    ['content-type', 'application/json'],
    ['host', url.host],
    ['x-amz-content-sha256', bodyHash],
    ['x-amz-date', amzDate],
  ] as const;
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
  const canonicalRequest = [
    'POST',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    bodyHash,
  ].join('\n');
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization = `${algorithm} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
    },
    body,
    signal: AbortSignal.timeout(config.sendTimeoutMs),
  });
  const responseText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
  } catch {
    parsed = { raw: responseText };
  }

  if (!response.ok) {
    const details = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.Message === 'string'
        ? parsed.Message
        : responseText;
    throw new Error(`Postbox SendEmail failed with HTTP ${response.status}: ${details}`);
  }

  const messageId = typeof parsed.MessageId === 'string'
    ? parsed.MessageId
    : typeof parsed.MessageID === 'string'
      ? parsed.MessageID
      : null;

  return {
    sent: true,
    provider: 'yandex-postbox' as const,
    messageId,
    subject: message.subject,
  };
}

export function createEmailNotificationService(config: PostboxConfig): EmailNotificationService {
  return {
    async sendRegistrationCreated(input) {
      const rendered = renderRegistrationEmail(input, config.timeZone);
      return sendPostboxEmail(config, {
        to: input.email,
        ...rendered,
      });
    },
    async sendSpecialApplicationCreated(input) {
      const rendered = renderSpecialApplicationEmail(input, config.timeZone);
      return sendPostboxEmail(config, {
        to: input.email,
        ...rendered,
      });
    },
    async sendSpecialWinner(input) {
      const rendered = renderSpecialWinnerEmail(input, config.timeZone);
      return sendPostboxEmail(config, {
        to: input.email,
        ...rendered,
      });
    },
    async sendSpecialSocialActivityReminder(input) {
      const rendered = renderSpecialSocialActivityReminderEmail(input, config.timeZone);
      return sendPostboxEmail(config, {
        to: input.email,
        ...rendered,
      });
    },
  };
}
