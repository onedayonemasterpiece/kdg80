from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, got {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def sub_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, got {count}: {pattern!r}")
    write(path, updated)


# 1. Production migration: configurable draw lead, citizenship gate and winner-email settings.
write(
    "registration/src/db/migrations/019_special_winner_communications.sql",
    """ALTER TABLE special_events
  ADD COLUMN auto_draw_lead_hours INTEGER NOT NULL DEFAULT 24
  CHECK (auto_draw_lead_hours BETWEEN 1 AND 168);

ALTER TABLE special_events
  ADD COLUMN requires_russian_citizenship INTEGER NOT NULL DEFAULT 0
  CHECK (requires_russian_citizenship IN (0, 1));

ALTER TABLE special_events
  ADD COLUMN winner_email_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (winner_email_enabled IN (0, 1));

ALTER TABLE special_events
  ADD COLUMN winner_response_deadline_hours INTEGER NOT NULL DEFAULT 24
  CHECK (winner_response_deadline_hours BETWEEN 1 AND 168);

ALTER TABLE special_applications
  ADD COLUMN russian_citizenship_confirmed INTEGER NOT NULL DEFAULT 0
  CHECK (russian_citizenship_confirmed IN (0, 1));

UPDATE special_events
SET auto_draw_lead_hours = 48,
    requires_russian_citizenship = 1,
    winner_email_enabled = 1,
    winner_response_deadline_hours = 24,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'amber-combine-jewelry-excursion';
""",
)

# 2. Special application model and API validation.
path = "registration/src/services/special-applications.ts"
replace_once(
    path,
    "  hide_public_quota: number;\n};",
    "  hide_public_quota: number;\n  auto_draw_lead_hours: number;\n  requires_russian_citizenship: number;\n  winner_email_enabled: number;\n  winner_response_deadline_hours: number;\n};",
)
replace_once(
    path,
    "  consentAccepted: boolean;\n  photos: SpecialPhotoPayload[];",
    "  consentAccepted: boolean;\n  russianCitizenshipConfirmed?: boolean;\n  photos: SpecialPhotoPayload[];",
)
replace_once(
    path,
    "    quotaVisibility: event.hide_public_quota ? 'hidden' as const : 'visible' as const,\n    minStampCount: event.min_stamp_count,",
    "    quotaVisibility: event.hide_public_quota ? 'hidden' as const : 'visible' as const,\n    requiresRussianCitizenship: Boolean(event.requires_russian_citizenship),\n    minStampCount: event.min_stamp_count,",
)
replace_once(
    path,
    "  if (loaded.event.public_state === 'closed') {\n    throw new SpecialApplicationError(410, 'special_event_closed', 'Заявки на это спецмероприятие закрыты.');\n  }\n\n  const selectedSlugs = Array.isArray(payload.selectedShowingSlugs)",
    "  if (loaded.event.public_state === 'closed') {\n    throw new SpecialApplicationError(410, 'special_event_closed', 'Заявки на это спецмероприятие закрыты.');\n  }\n\n  if (loaded.event.requires_russian_citizenship && !payload.russianCitizenshipConfirmed) {\n    throw new SpecialApplicationError(\n      400,\n      'russian_citizenship_confirmation_required',\n      'Подтвердите гражданство Российской Федерации. К розыгрышу допускаются только граждане РФ.',\n    );\n  }\n\n  const selectedSlugs = Array.isArray(payload.selectedShowingSlugs)",
)
replace_once(
    path,
    "        selected_showing_ids_json,\n        status,",
    "        selected_showing_ids_json,\n        russian_citizenship_confirmed,\n        status,",
)
replace_once(
    path,
    "        @selectedShowingIdsJson,\n        @status,",
    "        @selectedShowingIdsJson,\n        @russianCitizenshipConfirmed,\n        @status,",
)
replace_once(
    path,
    "      selectedShowingIdsJson: JSON.stringify(selectedShowingIds),\n      status,",
    "      selectedShowingIdsJson: JSON.stringify(selectedShowingIds),\n      russianCitizenshipConfirmed: payload.russianCitizenshipConfirmed ? 1 : 0,\n      status,",
)
replace_once(
    path,
    "  if (!testApplication) {\n    enqueueSpecialApplicationCreated(deps.db, {\n      applicationId,\n    });\n  }",
    "  enqueueSpecialApplicationCreated(deps.db, {\n    applicationId,\n  });",
)
replace_once(
    path,
    "    phone,\n    status,",
    "    phone,\n    russianCitizenshipConfirmed: Boolean(payload.russianCitizenshipConfirmed),\n    status,",
)

# 3. Multipart application parsing.
path = "registration/src/api/special.ts"
replace_once(
    path,
    "    consentAccepted: multipartField(parts, 'consentAccepted') === 'on' || multipartField(parts, 'consentAccepted') === 'true',\n    website:",
    "    consentAccepted: multipartField(parts, 'consentAccepted') === 'on' || multipartField(parts, 'consentAccepted') === 'true',\n    russianCitizenshipConfirmed: multipartField(parts, 'russianCitizenshipConfirmed') === 'on'\n      || multipartField(parts, 'russianCitizenshipConfirmed') === 'true',\n    website:",
)

# 4. Draw timing, eligibility and Telegram admin confirmation command support.
path = "registration/src/services/special-draws.ts"
replace_once(
    path,
    "  previous_winner_weight_percent: number;\n};",
    "  previous_winner_weight_percent: number;\n  auto_draw_lead_hours: number;\n  requires_russian_citizenship: number;\n  winner_email_enabled: number;\n  winner_response_deadline_hours: number;\n};",
)
replace_once(
    path,
    "  status: string;\n  uploaded_photo_count:",
    "  status: string;\n  russian_citizenship_confirmed: number;\n  uploaded_photo_count:",
)
replace_once(
    path,
    "  previousWinnerWeightPercent: number;\n  createdAt:",
    "  previousWinnerWeightPercent: number;\n  russianCitizenshipConfirmed: boolean;\n  createdAt:",
)
replace_once(
    path,
    "    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent\n    FROM special_events",
    "    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent,\n      auto_draw_lead_hours, requires_russian_citizenship, winner_email_enabled, winner_response_deadline_hours\n    FROM special_events",
)
replace_once(
    path,
    "      e.previous_winner_weight_percent AS event_previous_winner_weight_percent,\n      s.id AS showing_id,",
    "      e.previous_winner_weight_percent AS event_previous_winner_weight_percent,\n      e.auto_draw_lead_hours AS event_auto_draw_lead_hours,\n      e.requires_russian_citizenship AS event_requires_russian_citizenship,\n      e.winner_email_enabled AS event_winner_email_enabled,\n      e.winner_response_deadline_hours AS event_winner_response_deadline_hours,\n      s.id AS showing_id,",
)
replace_once(
    path,
    "      AND datetime(?) >= datetime(s.starts_at, '-24 hours')",
    "      AND datetime(?) >= datetime(s.starts_at, printf('-%d hours', e.auto_draw_lead_hours))",
)
replace_once(
    path,
    "    event_previous_winner_weight_percent: number;\n    showing_id:",
    "    event_previous_winner_weight_percent: number;\n    event_auto_draw_lead_hours: number;\n    event_requires_russian_citizenship: number;\n    event_winner_email_enabled: number;\n    event_winner_response_deadline_hours: number;\n    showing_id:",
)
replace_once(
    path,
    "      previous_winner_weight_percent: row.event_previous_winner_weight_percent,\n    },",
    "      previous_winner_weight_percent: row.event_previous_winner_weight_percent,\n      auto_draw_lead_hours: row.event_auto_draw_lead_hours,\n      requires_russian_citizenship: row.event_requires_russian_citizenship,\n      winner_email_enabled: row.event_winner_email_enabled,\n      winner_response_deadline_hours: row.event_winner_response_deadline_hours,\n    },",
)
replace_once(
    path,
    "    autoPublishAt: new Date(new Date(row.showing_starts_at).getTime() - 24 * 60 * 60 * 1000).toISOString(),",
    "    autoPublishAt: new Date(\n      new Date(row.showing_starts_at).getTime() - row.event_auto_draw_lead_hours * 60 * 60 * 1000,\n    ).toISOString(),",
)
replace_once(
    path,
    "        previousWinnerWeightPercent: row.previous_winner_weight_percent,\n        createdAt:",
    "        previousWinnerWeightPercent: row.previous_winner_weight_percent,\n        russianCitizenshipConfirmed: Boolean(row.russian_citizenship_confirmed),\n        createdAt:",
)
replace_once(
    path,
    "    previousWinnerWeightPercent: participant.previousWinnerWeightPercent,\n    createdAt:",
    "    previousWinnerWeightPercent: participant.previousWinnerWeightPercent,\n    russianCitizenshipConfirmed: participant.russianCitizenshipConfirmed,\n    createdAt:",
)
replace_once(
    path,
    "  const candidateRows = listCandidateRows(db, showing);\n  const candidates = mapParticipants(candidateRows, privateKeyPemBase64, loadBonusesForRows(db, candidateRows));",
    "  const candidateRows = listCandidateRows(db, showing);\n  const allCandidates = mapParticipants(candidateRows, privateKeyPemBase64, loadBonusesForRows(db, candidateRows));\n  const candidates = event.requires_russian_citizenship\n    ? allCandidates.filter((candidate) => candidate.russianCitizenshipConfirmed)\n    : allCandidates;",
)
replace_once(
    path,
    "    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent\n    FROM special_events\n    ORDER BY",
    "    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent,\n      auto_draw_lead_hours, requires_russian_citizenship, winner_email_enabled, winner_response_deadline_hours\n    FROM special_events\n    ORDER BY",
)
replace_once(
    path,
    "    acceptedApplicationCount: acceptedRows.length,\n    candidates,",
    "    acceptedApplicationCount: acceptedRows.length,\n    eligibleApplicationCount: event.requires_russian_citizenship\n      ? candidates.filter((candidate) => candidate.russianCitizenshipConfirmed).length\n      : candidates.length,\n    candidates,",
)
replace_once(
    path,
    "    `Допущенных заявок: ${item.acceptedApplicationCount}`,\n    `Статус розыгрыша:",
    "    `Принятых заявок: ${item.acceptedApplicationCount}`,\n    `Допущено к розыгрышу: ${item.eligibleApplicationCount}`,\n    item.event.requires_russian_citizenship ? 'Требование: гражданство Российской Федерации' : 'Требование по гражданству: нет',\n    `Статус розыгрыша:",
)
replace_once(
    path,
    "    `   Фото: ${candidate.acceptedPhotoCount}/${candidate.uniquePhotoCount}/${candidate.uploadedPhotoCount}`,",
    "    `   Гражданство РФ: ${candidate.russianCitizenshipConfirmed ? 'подтверждено' : 'не подтверждено'}`,\n    `   Фото: ${candidate.acceptedPhotoCount}/${candidate.uniquePhotoCount}/${candidate.uploadedPhotoCount}`,",
)
replace_once(
    path,
    "export function listSpecialApplicationPhotos(db: Database.Database, applicationId: number) {",
    "export function confirmSpecialApplicationRussianCitizenship(\n  db: Database.Database,\n  applicationCode: string,\n) {\n  const normalizedCode = applicationCode.trim();\n  if (!normalizedCode) {\n    return null;\n  }\n\n  return db.prepare(`\n    UPDATE special_applications\n    SET russian_citizenship_confirmed = 1\n    WHERE application_code = ?\n      AND status = 'accepted'\n    RETURNING id, application_code\n  `).get(normalizedCode) as { id: number; application_code: string } | undefined ?? null;\n}\n\nexport function listSpecialApplicationPhotos(db: Database.Database, applicationId: number) {",
)

# 5. Telegram bot: show and manually confirm legacy applicants.
path = "registration/src/services/telegram-bot.ts"
replace_once(
    path,
    "  buildSpecialDrawXlsxBuffer,\n  formatSpecialDrawResult,",
    "  buildSpecialDrawXlsxBuffer,\n  confirmSpecialApplicationRussianCitizenship,\n  formatSpecialDrawResult,",
)
replace_once(
    path,
    "    lines.push('/spec — спецмероприятия, черновой и опубликованный розыгрыш.');",
    "    lines.push('/spec — спецмероприятия, черновой и опубликованный розыгрыш.');\n    lines.push('/citizenship_confirm <код заявки> — подтвердить гражданство РФ для ранее поданной заявки.');",
)
replace_once(
    path,
    "  bot.command('health', async (ctx) => {",
    "  bot.command('citizenship_confirm', async (ctx) => {\n    const admin = requireAdminRole(String(ctx.from?.id ?? ''));\n    if (!admin || admin.role !== 'superadmin') {\n      await ctx.reply('Подтверждать гражданство может только суперадмин.');\n      return;\n    }\n\n    const commandText = ctx.message?.text ?? '';\n    const applicationCode = commandText.replace(/^\\/citizenship_confirm(@\\w+)?/u, '').trim();\n    if (!applicationCode) {\n      await ctx.reply('Укажите код заявки: /citizenship_confirm <код заявки>');\n      return;\n    }\n\n    const confirmed = confirmSpecialApplicationRussianCitizenship(deps.db, applicationCode);\n    if (!confirmed) {\n      await ctx.reply('Принятая заявка с таким кодом не найдена.');\n      return;\n    }\n\n    await ctx.reply(`Гражданство РФ подтверждено для заявки ${confirmed.application_code}.`);\n  });\n\n  bot.command('health', async (ctx) => {",
)

# 6. TEST notifications are visible to the administrator instead of being silently suppressed.
path = "registration/src/services/telegram-outbox.ts"
replace_once(
    path,
    "function formatSpecialApplicationCreatedMessage(payload:",
    "export function formatSpecialApplicationCreatedMessage(payload:",
)
replace_once(
    path,
    "  const lines = [\n    'Новая заявка на розыгрыш',",
    "  const testApplication = payload.applicationCode.startsWith('TEST-');\n  const lines = [\n    testApplication ? 'ТЕСТОВАЯ заявка на розыгрыш' : 'Новая заявка на розыгрыш',\n    testApplication ? 'Технический E2E: заявка будет удалена после проверки.' : null,",
)

# 7. Winner email renderer and sender.
path = "registration/src/services/email-notifications.ts"
replace_once(
    path,
    "  sendSpecialApplicationCreated(input: SpecialApplicationEmailInput): Promise<EmailSendResult>;\n  sendSpecialSocialActivityReminder",
    "  sendSpecialApplicationCreated(input: SpecialApplicationEmailInput): Promise<EmailSendResult>;\n  sendSpecialWinner(input: SpecialWinnerEmailInput): Promise<EmailSendResult>;\n  sendSpecialSocialActivityReminder",
)
replace_once(
    path,
    "export type SpecialSocialActivityReminderEmailInput = {",
    "export type SpecialWinnerEmailInput = {\n  applicationCode: string;\n  fullName: string;\n  email: string;\n  event: {\n    slug: string;\n    title: string;\n    venueName: string;\n  };\n  showing: {\n    displayLabel: string;\n    startsAt: string;\n  };\n  replyDeadline: string;\n};\n\nexport type SpecialSocialActivityReminderEmailInput = {",
)
replace_once(
    path,
    "export function renderSpecialSocialActivityReminderEmail(\n",
    "export function renderSpecialWinnerEmail(input: SpecialWinnerEmailInput, timeZone: string) {\n  const startsAt = formatDateTime(input.showing.startsAt, timeZone);\n  const replyDeadline = formatDateTime(input.replyDeadline, timeZone);\n  const subject = `Вы победили в розыгрыше: ${input.event.title}`;\n  const consentLine = 'Отправляя паспортные данные ответным письмом, вы подтверждаете согласие на их обработку и передачу Калининградскому янтарному комбинату исключительно для оформления разового пропуска на эту экскурсию.';\n  const text = [\n    `Здравствуйте, ${input.fullName}!`,\n    '',\n    `Вы стали победителем розыгрыша на спецмероприятие «${input.event.title}».`,\n    `Дата и время: ${startsAt}.`,\n    `Площадка: ${input.event.venueName}.`,\n    '',\n    `Ответьте на это письмо не позднее ${replyDeadline} и укажите:`,\n    '1. Полное ФИО.',\n    '2. Серию и номер паспорта гражданина Российской Федерации.',\n    '',\n    'К участию допускаются только граждане Российской Федерации.',\n    'Фотографию или скан паспорта отправлять не нужно.',\n    consentLine,\n    '',\n    'Если данные не будут получены в указанный срок, организатор вправе передать место другому участнику.',\n    'Точную точку сбора и требования пропускного режима мы направим дополнительно после оформления списка участников.',\n    '',\n    `Код заявки: ${input.applicationCode}.`,\n    '',\n    footerText(),\n  ].join('\\n');\n  const html = `<!doctype html>\n<html lang=\"ru\">\n<head><meta charset=\"utf-8\"><title>${escapeHtml(subject)}</title></head>\n<body style=\"margin:0;padding:24px;background:#f7f1e8;color:#12110e;font-family:Arial,Helvetica,sans-serif;line-height:1.5;\">\n  <main style=\"max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;padding:28px;border:1px solid #eadfce;\">\n    <p style=\"margin:0 0 10px;color:#9f3429;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;\">Победа в розыгрыше</p>\n    <h1 style=\"margin:0 0 18px;font-size:25px;line-height:1.2;\">${escapeHtml(input.event.title)}</h1>\n    ${paragraphsHtml([\n      `Здравствуйте, ${input.fullName}!`,\n      `Вы стали победителем розыгрыша. Дата и время: ${startsAt}.`,\n      `Площадка: ${input.event.venueName}.`,\n      `Ответьте на это письмо не позднее ${replyDeadline}.`,\n    ])}\n    <div style=\"margin:20px 0;padding:18px;border-radius:14px;background:#f3e5d4;border:1px solid #dfc8ae;\">\n      <strong>В ответном письме укажите:</strong>\n      <ol style=\"margin:10px 0 0;padding-left:22px;\">\n        <li>полное ФИО;</li>\n        <li>серию и номер паспорта гражданина Российской Федерации.</li>\n      </ol>\n    </div>\n    ${paragraphsHtml([\n      'К участию допускаются только граждане Российской Федерации.',\n      'Фотографию или скан паспорта отправлять не нужно.',\n      consentLine,\n      'Если данные не будут получены в указанный срок, организатор вправе передать место другому участнику.',\n      'Точную точку сбора и требования пропускного режима мы направим дополнительно после оформления списка участников.',\n      `Код заявки: ${input.applicationCode}.`,\n    ])}\n    <hr style=\"border:0;border-top:1px solid #eadfce;margin:24px 0;\">\n    <p style=\"margin:0;color:#554f48;\">${footerHtml()}</p>\n  </main>\n</body>\n</html>`;\n\n  return { subject, text, html };\n}\n\nexport function renderSpecialSocialActivityReminderEmail(\n",
)
replace_once(
    path,
    "    async sendSpecialSocialActivityReminder(input) {",
    "    async sendSpecialWinner(input) {\n      const rendered = renderSpecialWinnerEmail(input, config.timeZone);\n      return sendPostboxEmail(config, {\n        to: input.email,\n        ...rendered,\n      });\n    },\n    async sendSpecialSocialActivityReminder(input) {",
)

# 8. Send winner emails immediately after the 48-hour published draw with retries and audit rows.
path = "registration/src/services/daily-jobs.ts"
replace_once(
    path,
    "import {\n  buildSpecialDrawXlsxBuffer,\n  listSpecialShowingsDueForAutoDraw,\n  runSpecialDraw,\n} from './special-draws';",
    "import {\n  buildSpecialDrawXlsxBuffer,\n  listSpecialShowingsDueForAutoDraw,\n  runSpecialDraw,\n  type SpecialDrawResult,\n} from './special-draws';\nimport type { EmailNotificationService, EmailSendResult, SpecialWinnerEmailInput } from './email-notifications';\nimport { recordEmailNotification } from './email-stats';",
)
replace_once(
    path,
    "  syncPublicStateManifest: (reason: string) => Promise<boolean>;\n};",
    "  syncPublicStateManifest: (reason: string) => Promise<boolean>;\n  emailNotifications: EmailNotificationService;\n  fingerprintSecret: string | null;\n  postboxConfigurationSetName: string | null;\n};",
)
replace_once(
    path,
    "async function runDueSpecialDraws(deps: DailyJobDeps, now: Date) {",
    "function acceptedWinnerEmailExists(db: Database.Database, applicationId: number) {\n  const row = db.prepare(`\n    SELECT 1 AS found\n    FROM email_notifications\n    WHERE entity_type = 'special_application'\n      AND entity_id = ?\n      AND template = 'special_draw_winner'\n      AND status != 'send_failed'\n    LIMIT 1\n  `).get(applicationId) as { found: number } | undefined;\n  return Boolean(row?.found);\n}\n\nasync function sendWinnerEmailWithRetry(\n  service: EmailNotificationService,\n  input: SpecialWinnerEmailInput,\n) {\n  let lastError: unknown = null;\n  for (let attempt = 1; attempt <= 3; attempt += 1) {\n    try {\n      return await service.sendSpecialWinner(input);\n    } catch (error) {\n      lastError = error;\n      if (attempt < 3) {\n        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));\n      }\n    }\n  }\n\n  return {\n    sent: false,\n    provider: 'yandex-postbox',\n    messageId: null,\n    reason: lastError instanceof Error ? lastError.message.slice(0, 240) : 'send_failed',\n  } satisfies EmailSendResult;\n}\n\nasync function sendSpecialWinnerEmails(deps: DailyJobDeps, result: SpecialDrawResult) {\n  if (!result.event.winner_email_enabled) {\n    return { sent: 0, failed: 0, skipped: result.winners.length };\n  }\n\n  const replyDeadline = new Date(\n    new Date(result.showing.starts_at).getTime()\n      - result.event.winner_response_deadline_hours * 60 * 60 * 1000,\n  ).toISOString();\n  let sent = 0;\n  let failed = 0;\n  let skipped = 0;\n\n  for (const winner of result.winners) {\n    if (acceptedWinnerEmailExists(deps.db, winner.applicationId)) {\n      skipped += 1;\n      continue;\n    }\n\n    const input: SpecialWinnerEmailInput = {\n      applicationCode: winner.applicationCode,\n      fullName: winner.fullName,\n      email: winner.email,\n      event: {\n        slug: result.event.slug,\n        title: result.event.title,\n        venueName: result.event.venue_name,\n      },\n      showing: {\n        displayLabel: result.showing.display_label,\n        startsAt: result.showing.starts_at,\n      },\n      replyDeadline,\n    };\n    const emailResult = await sendWinnerEmailWithRetry(deps.emailNotifications, input);\n    recordEmailNotification(deps.db, {\n      entityType: 'special_application',\n      entityId: winner.applicationId,\n      template: 'special_draw_winner',\n      recipientEmail: winner.email,\n      subject: emailResult.subject || `Вы победили в розыгрыше: ${result.event.title}`,\n      configurationSetName: deps.postboxConfigurationSetName,\n      fingerprintSecret: deps.fingerprintSecret,\n      result: emailResult,\n    });\n\n    if (emailResult.sent) {\n      sent += 1;\n    } else {\n      failed += 1;\n    }\n  }\n\n  return { sent, failed, skipped };\n}\n\nasync function runDueSpecialDraws(deps: DailyJobDeps, now: Date) {",
)
replace_once(
    path,
    "      const result = runSpecialDraw(deps.db, item.showing.id, 'published', deps.privateKeyPemBase64);\n      try {",
    "      const result = runSpecialDraw(deps.db, item.showing.id, 'published', deps.privateKeyPemBase64);\n      const winnerEmailSummary = await sendSpecialWinnerEmails(deps, result);\n      try {",
)
replace_once(
    path,
    "          'Автоматический опубликованный розыгрыш за сутки до показа.',",
    "          `Автоматический опубликованный розыгрыш за ${result.event.auto_draw_lead_hours} часов до события.`,",
)
replace_once(
    path,
    "          `Источник случайности: ${result.drawMechanism.randomSource}`,",
    "          `Источник случайности: ${result.drawMechanism.randomSource}`,\n          `Письма победителям: отправлено ${winnerEmailSummary.sent}, пропущено ${winnerEmailSummary.skipped}, ошибок ${winnerEmailSummary.failed}.`,",
)

# 9. Wire email dependencies into daily jobs.
path = "registration/src/server.ts"
replace_once(
    path,
    "    syncPublicStateManifest,\n  });",
    "    syncPublicStateManifest,\n    emailNotifications,\n    fingerprintSecret: config.piiFingerprintSecret,\n    postboxConfigurationSetName: config.postboxConfigurationSetName,\n  });",
)

# 10. Public page: 9 August draw, RF citizenship and passport-data notice.
path = "site/src/pages/special/amber-combine-jewelry-excursion.astro"
replace_once(
    path,
    "        <p class=\"special-note\"><strong>Важно:</strong> заявка не является билетом. Участие возможно только после персонального подтверждения победы организаторами. Точку сбора и требования пропускного режима победители получат отдельно.</p>",
    "        <p class=\"special-note\"><strong>Важно:</strong> заявка не является билетом. К розыгрышу допускаются только граждане Российской Федерации. Победителям потребуется ответить на письмо организатора и предоставить полное ФИО, серию и номер паспорта гражданина РФ для оформления пропуска. Фотографию или скан паспорта отправлять не нужно.</p>",
)
replace_once(
    path,
    "          <span>Розыгрыш запланирован автоматически за сутки до экскурсии — 10 августа 2026 года.</span>",
    "          <span>Розыгрыш и отправка писем победителям запланированы за 48 часов до экскурсии — 9 августа 2026 года в 11:00.</span>",
)
replace_once(
    path,
    "        <label class=\"special-consent\">\n          <input name=\"consentAccepted\"",
    "        <label class=\"special-consent\">\n          <input name=\"russianCitizenshipConfirmed\" type=\"checkbox\" required />\n          <span>Подтверждаю, что являюсь гражданином Российской Федерации и в случае победы предоставлю полное ФИО, серию и номер паспорта гражданина РФ для оформления пропуска на предприятие.</span>\n        </label>\n\n        <label class=\"special-consent\">\n          <input name=\"consentAccepted\"",
)
replace_once(
    path,
    "      if (formData.get('consentAccepted') === 'on') {\n        payload.append('consentAccepted', 'on');\n      }",
    "      if (formData.get('consentAccepted') === 'on') {\n        payload.append('consentAccepted', 'on');\n      }\n      if (formData.get('russianCitizenshipConfirmed') === 'on') {\n        payload.append('russianCitizenshipConfirmed', 'on');\n      }",
)
replace_once(
    path,
    "              consentAccepted: formData.get('consentAccepted') === 'on',\n              website:",
    "              consentAccepted: formData.get('consentAccepted') === 'on',\n              russianCitizenshipConfirmed: formData.get('russianCitizenshipConfirmed') === 'on',\n              website:",
)
replace_once(
    path,
    "            ? 'Заявка принята к розыгрышу. Это не билет; результаты будут подведены отдельно.'",
    "            ? 'Заявка принята к розыгрышу. Результаты будут подведены 9 августа; победители получат письмо на указанный email.'",
)

# 11. Requirements and event specification.
path = "docs/amber-combine-jewelry-excursion-2026-08-11.md"
text = read(path)
text = text.replace("Победителей определяет автоматический розыгрыш за сутки до события — `10 августа 2026 года`.", "Победителей определяет автоматический розыгрыш за 48 часов до события — `9 августа 2026 года, 11:00`.")
text = text.replace("- Заявка не является билетом.", "- К розыгрышу допускаются только граждане Российской Федерации; подтверждение является обязательным полем заявки.\n- Заявка не является билетом.")
text += "\n## Коммуникация с победителями\n\n- Письма победителям отправляются автоматически сразу после опубликованного розыгрыша 9 августа.\n- В ответ победитель должен прислать полное ФИО, серию и номер паспорта гражданина Российской Федерации.\n- Фото или скан паспорта не запрашиваются.\n- Срок ответа: до 10 августа 2026 года, 11:00.\n- Шаблон письма направляется на `info@kgd80.ru` для визуального согласования.\n- Две заявки, поданные до появления требования о гражданстве, имеют статус `не подтверждено`; суперадмин подтверждает их после получения явного ответа командой `/citizenship_confirm <код заявки>`.\n"
write(path, text)

path = "Исходные данные/Спецмероприятия/specialregistration.md"
text = read(path)
text = text.replace("- Розыгрыш автоматически проводится за сутки до экскурсии — `10 августа 2026 года`.", "- Розыгрыш автоматически проводится за 48 часов до экскурсии — `9 августа 2026 года, 11:00`.")
text += "\n- К розыгрышу допускаются только граждане Российской Федерации; заявитель подтверждает гражданство отдельным обязательным checkbox. — Статус: `Не подтверждено пользователем`\n- Письмо победителю отправляется сразу после розыгрыша 9 августа и просит ответить до 10 августа 11:00, указав полное ФИО, серию и номер паспорта гражданина РФ; фото/скан паспорта не требуется. — Статус: `Не подтверждено пользователем`\n- Ранее поданные заявки без нового checkbox не участвуют в розыгрыше до ручного подтверждения суперадмином командой `/citizenship_confirm <код заявки>`. — Статус: `Не подтверждено пользователем`\n"
write(path, text)

# 12. Focused tests.
write(
    "registration/src/services/special-amber-eligibility.test.ts",
    """import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import {
  confirmSpecialApplicationRussianCitizenship,
  listSpecialShowingsDueForAutoDraw,
  runSpecialDraw,
} from './special-draws';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKeyPemBase64: Buffer.from(publicKey).toString('base64'),
    privateKeyPemBase64: Buffer.from(privateKey).toString('base64'),
  };
}

function insertCandidate(
  db: Database.Database,
  publicKeyPemBase64: string,
  showingId: number,
  code: string,
  email: string,
  citizenshipConfirmed: boolean,
) {
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: code.includes('PENDING') ? 'Елена Ожидающая' : 'Анна Подтвержденная',
    email,
    phone: code.includes('PENDING') ? '+79001111111' : '+79002222222',
  });
  const info = db.prepare(`
    INSERT INTO special_applications (
      application_code, special_event_id,
      pii_ciphertext, pii_wrapped_key, pii_iv, pii_alg,
      full_name_fingerprint, email_fingerprint, phone_fingerprint,
      selected_showing_ids_json, russian_citizenship_confirmed,
      status, uploaded_photo_count, unique_photo_count, accepted_photo_count,
      stamp_count, ordinary_registration_count, no_show_count, score,
      ocr_provider, ocr_summary_json,
      consent_version, consent_text_hash, consent_accepted_at
    ) VALUES (
      ?, (SELECT special_event_id FROM special_event_showings WHERE id = ?),
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      'accepted', 1, 1, 1, 5, 0, 0, 10,
      'test', '{}', 'test', 'test', '2026-08-01T00:00:00.000Z'
    )
  `).run(
    code,
    showingId,
    encrypted.piiCiphertext,
    encrypted.piiWrappedKey,
    encrypted.piiIv,
    encrypted.piiAlg,
    `${code}-name`,
    email,
    `${code}-phone`,
    JSON.stringify([showingId]),
    citizenshipConfirmed ? 1 : 0,
  );
  const applicationId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)')
    .run(applicationId, showingId);
  return applicationId;
}

test('amber draw starts exactly 48 hours before the excursion and excludes unconfirmed citizenship', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { publicKeyPemBase64, privateKeyPemBase64 } = keys();
  const showing = db.prepare(`
    SELECT id
    FROM special_event_showings
    WHERE slug = '2026-08-11-1100'
  `).get() as { id: number };

  assert.equal(
    listSpecialShowingsDueForAutoDraw(db, new Date('2026-08-09T08:59:59.000Z'))
      .some((item) => item.showing.id === showing.id),
    false,
  );
  const due = listSpecialShowingsDueForAutoDraw(db, new Date('2026-08-09T09:00:00.000Z'))
    .find((item) => item.showing.id === showing.id);
  assert.ok(due);
  assert.equal(due.autoPublishAt, '2026-08-09T09:00:00.000Z');
  assert.equal(due.event.auto_draw_lead_hours, 48);

  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-CONFIRMED', 'confirmed@example.com', true);
  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-PENDING', 'pending@example.com', false);

  const firstDraw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(firstDraw.totalCandidates, 1);
  assert.equal(firstDraw.candidates[0].applicationCode, 'AMBER-CONFIRMED');

  const confirmed = confirmSpecialApplicationRussianCitizenship(db, 'AMBER-PENDING');
  assert.equal(confirmed?.application_code, 'AMBER-PENDING');

  const secondDraw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(secondDraw.totalCandidates, 2);
  assert.deepEqual(
    new Set(secondDraw.candidates.map((candidate) => candidate.applicationCode)),
    new Set(['AMBER-CONFIRMED', 'AMBER-PENDING']),
  );
});
""",
)

write(
    "registration/src/services/special-winner-email.test.ts",
    """import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSpecialWinnerEmail } from './email-notifications';

test('winner email requests only the required Russian passport details and gives a deadline', () => {
  const rendered = renderSpecialWinnerEmail({
    applicationCode: 'TEST-CODE',
    fullName: 'Анна Иванова',
    email: 'anna@example.com',
    event: {
      slug: 'amber-combine-jewelry-excursion',
      title: 'Экскурсия на ювелирное производство Калининградского янтарного комбината',
      venueName: 'Калининградский янтарный комбинат',
    },
    showing: {
      displayLabel: '11 августа 11:00',
      startsAt: '2026-08-11T11:00:00+02:00',
    },
    replyDeadline: '2026-08-10T11:00:00+02:00',
  }, 'Europe/Kaliningrad');

  assert.match(rendered.subject, /Вы победили/);
  assert.match(rendered.text, /полное ФИО/i);
  assert.match(rendered.text, /серию и номер паспорта гражданина Российской Федерации/i);
  assert.match(rendered.text, /Фотографию или скан паспорта отправлять не нужно/i);
  assert.match(rendered.text, /10 августа/i);
  assert.match(rendered.text, /согласие на их обработку и передачу/i);
  assert.doesNotMatch(rendered.text, /код подразделения/i);
});
""",
)

path = "registration/package.json"
package = json.loads(read(path))
package["scripts"]["test:special-amber-eligibility"] = (
    "tsx --test src/services/special-amber-eligibility.test.ts src/services/special-winner-email.test.ts"
)
write(path, json.dumps(package, ensure_ascii=False, indent=2) + "\n")

print("Amber 48-hour draw, citizenship and winner email patch applied.")
