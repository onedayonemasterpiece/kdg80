from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


astro = read('site/src/pages/special/amber-combine-jewelry-excursion.astro')
api = read('registration/src/api/special.ts')
applications = read('registration/src/services/special-applications.ts')
draws = read('registration/src/services/special-draws.ts')
emails = read('registration/src/services/email-notifications.ts')
winner_sender = read('registration/scripts/send-amber-winner-email-preview.ts')

required = {
    'site citizenship notice': 'подать заявку могут только граждане Российской Федерации' in astro,
    '48-hour draw': 'auto_draw_lead_hours' in draws,
    'final winner subject': 'const subject = `Вы победили в розыгрыше: ${input.event.title}`;' in emails,
    'TEST cleanup after winner email': 'cleanupSpecialTestApplication' in winner_sender,
}
for label, ok in required.items():
    if not ok:
        raise SystemExit(f'Missing required correction: {label}')

forbidden = {
    'citizenship checkbox': 'name="russianCitizenshipConfirmed"' in astro,
    'citizenship API payload': 'russianCitizenshipConfirmed:' in api,
    'citizenship blocking error': 'russian_citizenship_confirmation_required' in applications,
    'internal approval marker': 'ПРОЕКТ ДЛЯ СОГЛАСОВАНИЯ' in emails,
    'internal approval copy': 'это письмо ещё не отправляется победителям' in emails,
}
for label, present in forbidden.items():
    if present:
        raise SystemExit(f'Forbidden implementation remains: {label}')

print('Amber corrections already applied; no source rewrite required.')
