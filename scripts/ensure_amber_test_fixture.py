from pathlib import Path

root = Path(__file__).resolve().parents[1]

fixture = root / 'registration/scripts/create-amber-test-application.ts'
text = fixture.read_text(encoding='utf-8')
text = text.replace(
    "const fullName = `TEST Проверка Почты ${timestamp.slice(-6)}`;",
    "const fullName = `ТЕСТ Проверка Почты ${timestamp.slice(-6)}`;",
)
fixture.write_text(text, encoding='utf-8')

cleanup = root / 'registration/src/services/special-test-cleanup.ts'
text = cleanup.read_text(encoding='utf-8')
text = text.replace(
    "  return normalized === 'ТЕСТ' || normalized.startsWith('ТЕСТ ');",
    "  return normalized === 'ТЕСТ'\n"
    "    || normalized.startsWith('ТЕСТ ')\n"
    "    || normalized === 'TEST'\n"
    "    || normalized.startsWith('TEST ');",
)
text = text.replace(
    "'Удаление разрешено только для заявок, где ФИО начинается с «ТЕСТ».'",
    "'Удаление разрешено только для заявок, где ФИО начинается с «ТЕСТ» или «TEST».'",
)
cleanup.write_text(text, encoding='utf-8')

print('Amber TEST fixture and cleanup compatibility ensured.')
