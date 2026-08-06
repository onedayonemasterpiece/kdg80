from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


# Keep applications that were accepted before the citizenship checkbox existed.
migration_path = "registration/src/db/migrations/019_special_winner_communications.sql"
migration = read(migration_path)
legacy_sql = """

-- Applications accepted before this rule was published remain eligible;
-- Russian citizenship is finally verified by the passport details supplied by winners.
UPDATE special_applications
SET russian_citizenship_confirmed = 1
WHERE special_event_id = (
  SELECT id
  FROM special_events
  WHERE slug = 'amber-combine-jewelry-excursion'
  LIMIT 1
)
  AND status = 'accepted';
"""
if legacy_sql.strip() not in migration:
    anchor = "WHERE slug = 'amber-combine-jewelry-excursion';\n"
    if anchor not in migration:
        raise RuntimeError("amber migration anchor not found")
    migration = migration.replace(anchor, anchor + legacy_sql, 1)
    write(migration_path, migration)


# Existing test mock must implement the extended EmailNotificationService interface.
mock_path = "registration/src/services/special-social-reminders.test.ts"
mock = read(mock_path)
old_mock = """    async sendSpecialApplicationCreated() {
      throw new Error('not used');
    },
    async sendSpecialSocialActivityReminder(input) {"""
new_mock = """    async sendSpecialApplicationCreated() {
      throw new Error('not used');
    },
    async sendSpecialWinner() {
      throw new Error('not used');
    },
    async sendSpecialSocialActivityReminder(input) {"""
if new_mock not in mock:
    if old_mock not in mock:
        raise RuntimeError("special-social-reminders mock anchor not found")
    write(mock_path, mock.replace(old_mock, new_mock, 1))


# Add the event image and a clear approval banner to the same renderer used for winners.
email_path = "registration/src/services/email-notifications.ts"
email = read(email_path)
if "previewMode?: boolean;" not in email:
    old_type = "  replyDeadline: string;\n};\n\nexport type SpecialSocialActivityReminderEmailInput"
    new_type = "  replyDeadline: string;\n  previewMode?: boolean;\n};\n\nexport type SpecialSocialActivityReminderEmailInput"
    if old_type not in email:
        raise RuntimeError("winner email input type anchor not found")
    email = email.replace(old_type, new_type, 1)

start = email.index("export function renderSpecialWinnerEmail")
end = email.index("export function renderSpecialSocialActivityReminderEmail")
segment = email[start:end]

old_subject = "  const subject = `Вы победили в розыгрыше: ${input.event.title}`;"
new_subject = """  const subject = `${input.previewMode ? '[ПРОЕКТ ДЛЯ СОГЛАСОВАНИЯ] ' : ''}Вы победили в розыгрыше: ${input.event.title}`;
  const heroImageUrl = input.event.slug === 'amber-combine-jewelry-excursion'
    ? 'https://kgd80.ru/generated/special/amber-combine-jewelry-production-email.jpg'
    : null;"""
if new_subject not in segment:
    if old_subject not in segment:
        raise RuntimeError("winner email subject anchor not found")
    segment = segment.replace(old_subject, new_subject, 1)

old_main = """  <main style=\"max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;padding:28px;border:1px solid #eadfce;\">
    <p style=\"margin:0 0 10px;color:#9f3429;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;\">Победа в розыгрыше</p>"""
new_main = """  <main style=\"max-width:640px;margin:0 auto;background:#fffaf2;border-radius:18px;overflow:hidden;border:1px solid #eadfce;\">
    ${heroImageUrl ? `<img src=\"${escapeHtml(heroImageUrl)}\" width=\"640\" alt=\"Ювелирное производство Калининградского янтарного комбината\" style=\"display:block;width:100%;height:auto;border:0;\">` : ''}
    <section style=\"padding:28px;\">
    ${input.previewMode ? '<div style=\"margin:0 0 18px;padding:10px 12px;border-radius:10px;background:#172434;color:#ffffff;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;\">Проект для согласования · это письмо ещё не отправляется победителям</div>' : ''}
    <p style=\"margin:0 0 10px;color:#9f3429;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;\">Победа в розыгрыше</p>"""
if new_main not in segment:
    if old_main not in segment:
        raise RuntimeError("winner email main block anchor not found")
    segment = segment.replace(old_main, new_main, 1)

old_end = """    <p style=\"margin:0;color:#554f48;\">${footerHtml()}</p>
  </main>"""
new_end = """    <p style=\"margin:0;color:#554f48;\">${footerHtml()}</p>
    </section>
  </main>"""
if new_end not in segment:
    if old_end not in segment:
        raise RuntimeError("winner email closing block anchor not found")
    segment = segment.replace(old_end, new_end, 1)

email = email[:start] + segment + email[end:]
write(email_path, email)


# Assert that the actual email HTML references the email-compatible public image.
test_path = "registration/src/services/special-winner-email.test.ts"
test_text = read(test_path)
image_assert = "  assert.match(rendered.html, /amber-combine-jewelry-production-email\\.jpg/);\n"
if image_assert not in test_text:
    anchor = "  assert.match(rendered.text, /согласие на их обработку и передачу/i);\n"
    if anchor not in test_text:
        raise RuntimeError("winner email test anchor not found")
    write(test_path, test_text.replace(anchor, anchor + image_assert, 1))


package_path = "registration/package.json"
package = json.loads(read(package_path))
package["scripts"]["send:amber-winner-preview"] = "tsx scripts/send-amber-winner-email-preview.ts"
write(package_path, json.dumps(package, ensure_ascii=False, indent=2) + "\n")

print("Amber winner email visual and preview sender finalized.")
