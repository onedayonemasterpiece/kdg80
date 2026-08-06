from __future__ import annotations

from pathlib import Path

PATH = Path('registration/scripts/create-amber-test-application.ts')
text = PATH.read_text(encoding='utf-8')

import_anchor = "import { recordEmailNotification } from '../src/services/email-stats.js';\n"
import_line = "import { enqueueSpecialApplicationCreated } from '../src/services/telegram-outbox.js';\n"
if import_line not in text:
    if import_anchor not in text:
        raise SystemExit('email-stats import anchor is missing')
    text = text.replace(import_anchor, import_anchor + import_line, 1)

insert_anchor = "})();\n\nconst service = createEmailNotificationService({"
insert_value = """})();

const telegramOutboxId = enqueueSpecialApplicationCreated(db, {
  applicationId,
});

const service = createEmailNotificationService({"""
if 'const telegramOutboxId = enqueueSpecialApplicationCreated' not in text:
    if insert_anchor not in text:
        raise SystemExit('application transaction anchor is missing')
    text = text.replace(insert_anchor, insert_value, 1)

wait_anchor = """if (!result.sent) {
  throw new Error(`Test application email was not sent: ${result.reason || 'unknown reason'}`);
}

db.close();
console.log(JSON.stringify({
"""
wait_value = """if (!result.sent) {
  throw new Error(`Test application email was not sent: ${result.reason || 'unknown reason'}`);
}

let telegramDelivered = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const pending = db.prepare('SELECT id FROM telegram_outbox WHERE id = ? LIMIT 1')
    .get(telegramOutboxId) as { id: number } | undefined;
  if (!pending) {
    telegramDelivered = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

if (!telegramDelivered) {
  throw new Error(`Telegram notification was not delivered within 60 seconds: ${telegramOutboxId}`);
}

db.close();
console.log(JSON.stringify({
"""
if 'let telegramDelivered = false;' not in text:
    if wait_anchor not in text:
        raise SystemExit('email result anchor is missing')
    text = text.replace(wait_anchor, wait_value, 1)

output_anchor = """  applicationId,
  sent: result.sent,
"""
output_value = """  applicationId,
  telegramOutboxId,
  telegramDelivered,
  sent: result.sent,
"""
if 'telegramOutboxId,' not in text.split('console.log(JSON.stringify({', 1)[-1]:
    if output_anchor not in text:
        raise SystemExit('output anchor is missing')
    text = text.replace(output_anchor, output_value, 1)

PATH.write_text(text, encoding='utf-8')
print('TEST application will enqueue and await a visible Telegram notification.')
