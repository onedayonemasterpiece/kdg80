from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, value: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding='utf-8')


def replace(path: str, old: str, new: str) -> None:
    value = read(path)
    count = value.count(old)
    if count > 1:
        raise SystemExit(f'Unexpected duplicate anchor in {path}: {old[:100]!r}')
    if count == 1:
        write(path, value.replace(old, new, 1))


def absent(path: str, *needles: str) -> None:
    value = read(path)
    for needle in needles:
        if needle in value:
            raise SystemExit(f'Forbidden text remains in {path}: {needle!r}')


def present(path: str, *needles: str) -> None:
    value = read(path)
    for needle in needles:
        if needle not in value:
            raise SystemExit(f'Required text missing in {path}: {needle!r}')


astro = 'site/src/pages/special/amber-combine-jewelry-excursion.astro'
replace(
    astro,
    '<p class="special-note"><strong>Важно:</strong> заявка не является билетом. К розыгрышу допускаются только граждане Российской Федерации. Победителям потребуется ответить на письмо организатора и предоставить полное ФИО, серию и номер паспорта гражданина РФ для оформления пропуска. Фотографию или скан паспорта отправлять не нужно.</p>',
    '<p class="special-note"><strong>Важно:</strong> подать заявку могут только граждане Российской Федерации. Заявка не является билетом. Победителям потребуется ответить на письмо организатора и предоставить полное ФИО, серию и номер паспорта гражданина РФ для оформления пропуска. Фотографию или скан паспорта отправлять не нужно.</p>',
)
replace(
    astro,
    '''        <label class="special-consent">\n          <input name="russianCitizenshipConfirmed" type="checkbox" required />\n          <span>Подтверждаю, что являюсь гражданином Российской Федерации и в случае победы предоставлю полное ФИО, серию и номер паспорта гражданина РФ для оформления пропуска на предприятие.</span>\n        </label>\n\n''',
    '',
)
replace(
    astro,
    '''      if (formData.get('russianCitizenshipConfirmed') === 'on') {\n        payload.append('russianCitizenshipConfirmed', 'on');\n      }\n''',
    '',
)
replace(
    astro,
    "              russianCitizenshipConfirmed: formData.get('russianCitizenshipConfirmed') === 'on',\n",
    '',
)

api = 'registration/src/api/special.ts'
replace(
    api,
    '''    russianCitizenshipConfirmed: multipartField(parts, 'russianCitizenshipConfirmed') === 'on'\n      || multipartField(parts, 'russianCitizenshipConfirmed') === 'true',\n''',
    '',
)
replace(
    api,
    '''  if (created.testApplication) {\n    logger.info({\n      route,\n      applicationId: created.applicationId,\n      status: created.status,\n      emailSent: false,\n      reason: 'test_application_suppressed',\n    }, 'special_application_email_notification_suppressed');\n    return {\n      sent: false,\n      provider: 'yandex-postbox',\n      messageId: null,\n      reason: 'test_application_suppressed',\n    };\n  }\n\n''',
    '',
)

applications = 'registration/src/services/special-applications.ts'
replace(applications, '  russianCitizenshipConfirmed?: boolean;\n', '')
replace(
    applications,
    '''  if (loaded.event.requires_russian_citizenship && !payload.russianCitizenshipConfirmed) {\n    throw new SpecialApplicationError(\n      400,\n      'russian_citizenship_confirmation_required',\n      'Подтвердите гражданство Российской Федерации. К розыгрышу допускаются только граждане РФ.',\n    );\n  }\n\n''',
    '',
)
replace(
    applications,
    '      russianCitizenshipConfirmed: payload.russianCitizenshipConfirmed ? 1 : 0,\n',
    '      russianCitizenshipConfirmed: 0,\n',
)
replace(
    applications,
    '    russianCitizenshipConfirmed: Boolean(payload.russianCitizenshipConfirmed),\n',
    '',
)

draws = 'registration/src/services/special-draws.ts'
replace(
    draws,
    '''    eligibleApplicationCount: event.requires_russian_citizenship\n      ? candidates.filter((candidate) => candidate.russianCitizenshipConfirmed).length\n      : candidates.length,\n''',
    '    eligibleApplicationCount: candidates.length,\n',
)
replace(
    draws,
    '''  const allCandidates = mapParticipants(candidateRows, privateKeyPemBase64, loadBonusesForRows(db, candidateRows));\n  const candidates = event.requires_russian_citizenship\n    ? allCandidates.filter((candidate) => candidate.russianCitizenshipConfirmed)\n    : allCandidates;\n''',
    '  const candidates = mapParticipants(candidateRows, privateKeyPemBase64, loadBonusesForRows(db, candidateRows));\n',
)
replace(
    draws,
    '''export function confirmSpecialApplicationRussianCitizenship(\n  db: Database.Database,\n  applicationCode: string,\n) {\n  const normalizedCode = applicationCode.trim();\n  if (!normalizedCode) {\n    return null;\n  }\n\n  return db.prepare(`\n    UPDATE special_applications\n    SET russian_citizenship_confirmed = 1\n    WHERE application_code = ?\n      AND status = 'accepted'\n    RETURNING id, application_code\n  `).get(normalizedCode) as { id: number; application_code: string } | undefined ?? null;\n}\n\n''',
    '',
)
replace(
    draws,
    '''    `Принятых заявок: ${item.acceptedApplicationCount}`,\n    `Допущено к розыгрышу: ${item.eligibleApplicationCount}`,\n    item.event.requires_russian_citizenship ? 'Требование: гражданство Российской Федерации' : 'Требование по гражданству: нет',\n''',
    '    `Допущенных заявок: ${item.acceptedApplicationCount}`,\n',
)
replace(
    draws,
    "    `   Гражданство РФ: ${candidate.russianCitizenshipConfirmed ? 'подтверждено' : 'не подтверждено'}`,\n",
    '',
)

telegram = 'registration/src/services/telegram-bot.ts'
replace(telegram, '  confirmSpecialApplicationRussianCitizenship,\n', '')
replace(
    telegram,
    "    lines.push('/citizenship_confirm <код заявки> — подтвердить гражданство РФ для ранее поданной заявки.');\n",
    '',
)
replace(
    telegram,
    '''  bot.command('citizenship_confirm', async (ctx) => {\n    const admin = requireAdminRole(String(ctx.from?.id ?? ''));\n    if (!admin || admin.role !== 'superadmin') {\n      await ctx.reply('Подтверждать гражданство может только суперадмин.');\n      return;\n    }\n\n    const commandText = ctx.message?.text ?? '';\n    const applicationCode = commandText.replace(/^\\/citizenship_confirm(@\\w+)?/u, '').trim();\n    if (!applicationCode) {\n      await ctx.reply('Укажите код заявки: /citizenship_confirm <код заявки>');\n      return;\n    }\n\n    const confirmed = confirmSpecialApplicationRussianCitizenship(deps.db, applicationCode);\n    if (!confirmed) {\n      await ctx.reply('Принятая заявка с таким кодом не найдена.');\n      return;\n    }\n\n    await ctx.reply(`Гражданство РФ подтверждено для заявки ${confirmed.application_code}.`);\n  });\n\n''',
    '',
)

emails = 'registration/src/services/email-notifications.ts'
replace(emails, '  previewMode?: boolean;\n', '')
replace(
    emails,
    "  const subject = `${input.previewMode ? '[ПРОЕКТ ДЛЯ СОГЛАСОВАНИЯ] ' : ''}Вы победили в розыгрыше: ${input.event.title}`;\n",
    '  const subject = `Вы победили в розыгрыше: ${input.event.title}`;\n',
)
replace(
    emails,
    '''    ${input.previewMode ? '<div style="margin:0 0 18px;padding:10px 12px;border-radius:10px;background:#172434;color:#ffffff;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;">Проект для согласования · это письмо ещё не отправляется победителям</div>' : ''}\n''',
    '',
)

write(
    'registration/src/services/special-amber-eligibility.test.ts',
    '''import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { encryptPii } from '../lib/crypto';
import { listSpecialShowingsDueForAutoDraw, runSpecialDraw } from './special-draws';

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

function insertCandidate(db: Database.Database, publicKeyPemBase64: string, showingId: number, code: string, email: string) {
  const encrypted = encryptPii(publicKeyPemBase64, {
    fullName: code.endsWith('ONE') ? 'Анна Первая' : 'Елена Вторая',
    email,
    phone: code.endsWith('ONE') ? '+79001111111' : '+79002222222',
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
      ?, ?, ?, ?, 0,
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
  );
  const applicationId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO special_application_showings(application_id, showing_id) VALUES (?, ?)')
    .run(applicationId, showingId);
}

test('amber draw starts 48 hours before the excursion and does not filter applicants by a citizenship checkbox', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { publicKeyPemBase64, privateKeyPemBase64 } = keys();
  const showing = db.prepare(`SELECT id FROM special_event_showings WHERE slug = '2026-08-11-1100'`)
    .get() as { id: number };
  const event = db.prepare(`SELECT requires_russian_citizenship FROM special_events WHERE slug = 'amber-combine-jewelry-excursion'`)
    .get() as { requires_russian_citizenship: number };

  assert.equal(event.requires_russian_citizenship, 0);
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

  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-ONE', 'one@example.com');
  insertCandidate(db, publicKeyPemBase64, showing.id, 'AMBER-TWO', 'two@example.com');
  const draw = runSpecialDraw(db, showing.id, 'draft', privateKeyPemBase64);
  assert.equal(draw.totalCandidates, 2);
  assert.deepEqual(
    new Set(draw.candidates.map((candidate) => candidate.applicationCode)),
    new Set(['AMBER-ONE', 'AMBER-TWO']),
  );
});
''',
)

write(
    'registration/src/services/special-winner-email.test.ts',
    '''import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSpecialWinnerEmail } from './email-notifications';

test('winner email is the exact final recipient version without internal approval markers', () => {
  const rendered = renderSpecialWinnerEmail({
    applicationCode: 'AMBER-2026-001',
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

  assert.equal(
    rendered.subject,
    'Вы победили в розыгрыше: Экскурсия на ювелирное производство Калининградского янтарного комбината',
  );
  assert.match(rendered.text, /полное ФИО/i);
  assert.match(rendered.text, /серия и номер/i);
  assert.match(rendered.text, /Фотографию или скан паспорта отправлять не нужно/i);
  assert.match(rendered.text, /10 августа/i);
  assert.match(rendered.html, /amber-combine-jewelry-production\.png/);
  assert.doesNotMatch(rendered.subject, /проект|согласован/iu);
  assert.doesNotMatch(rendered.text, /проект для согласования|это письмо ещё не отправляется/iu);
  assert.doesNotMatch(rendered.html, /проект для согласования|это письмо ещё не отправляется/iu);
  assert.doesNotMatch(rendered.text, /согласие на их обработку и передачу/i);
  assert.doesNotMatch(rendered.text, /код подразделения/i);
});
''',
)

write(
    'registration/scripts/send-amber-winner-email-preview.ts',
    '''import { loadConfig } from '../src/config';
import { createEmailNotificationService } from '../src/services/email-notifications';

const config = loadConfig();
const target = process.env.AMBER_WINNER_PREVIEW_EMAIL?.trim() || 'info@kgd80.ru';
const applicationCode = process.env.AMBER_WINNER_APPLICATION_CODE?.trim() || 'AMBER-2026-001';
const fullName = process.env.AMBER_WINNER_FULL_NAME?.trim() || 'Максим';
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
  applicationCode,
  fullName,
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
});

if (!result.sent) {
  throw new Error(`Winner email was not sent: ${result.reason || 'unknown reason'}`);
}

console.log(JSON.stringify({
  sent: result.sent,
  messageId: result.messageId,
  subject: result.subject,
  target,
  applicationCode,
}));
''',
)

package_path = ROOT / 'registration/package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package.setdefault('scripts', {})['create:amber-test-application'] = 'tsx scripts/create-amber-test-application.ts'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

absent(
    astro,
    'name="russianCitizenshipConfirmed"',
    'russianCitizenshipConfirmed:',
    "payload.append('russianCitizenshipConfirmed'",
    'Подтверждаю, что являюсь гражданином Российской Федерации',
)
present(astro, 'подать заявку могут только граждане Российской Федерации')
absent(api, 'test_application_suppressed', 'russianCitizenshipConfirmed:')
absent(applications, 'russian_citizenship_confirmation_required', 'payload.russianCitizenshipConfirmed')
present(applications, 'russianCitizenshipConfirmed: 0')
absent(draws, 'confirmSpecialApplicationRussianCitizenship', 'event.requires_russian_citizenship\n    ? allCandidates')
absent(telegram, 'citizenship_confirm', 'confirmSpecialApplicationRussianCitizenship')
absent(emails, 'previewMode', 'ПРОЕКТ ДЛЯ СОГЛАСОВАНИЯ', 'Проект для согласования')
present(emails, 'const subject = `Вы победили в розыгрыше: ${input.event.title}`;')

print('Amber registration control removed; exact final email and test-application sender prepared.')
