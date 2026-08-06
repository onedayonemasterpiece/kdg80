# Финальная задача кодовому агенту: реальная production-заявка и полное удаление TEST-данных

Модель: `Sol high`

Репозиторий: `onedayonemasterpiece/kdg80`

Рабочая ветка: `feat/amber-combine-jewelry-excursion`

Draft PR: `#1`

Не создавай новую ветку, не merge PR и не начинай тестовую механику заново. Код принятия заявки, подавления уведомлений для ФИО `ТЕСТ…`, выдачи одноразового cleanup-токена и полного удаления тестовой заявки уже подготовлен и покрыт focused-тестами.

## Что именно ещё не было доказано

Предыдущий выпуск проверил страницу, API события, загрузку/распознавание фотографий и память Fly, но не создавал принятую production-заявку. Поэтому не были пройдены единым реальным сценарием:

- POST принятой заявки;
- запись профиля, заявки, показа и фотографий в production DB;
- сохранение приватных фотографий;
- пользовательский success-экран и код заявки;
- TEST-подавление email/Telegram;
- полное удаление DB-строк и приватных файлов после проверки.

## 1. Обновить ветку и проверить код

```bash
git checkout feat/amber-combine-jewelry-excursion
git pull --ff-only origin feat/amber-combine-jewelry-excursion

cd registration
npm ci
npm run check
npm run test:special-test-cleanup
npm run test:special-public-quota
npm run test:special-draws
npm run test:special-social
```

Focused cleanup-тест должен дать `3/3`:

1. cleanup HMAC нельзя подделать;
2. TEST-заявка удаляет application/profile/private assets/outbox/email rows;
3. заявка без префикса `ТЕСТ` не может быть удалена этим endpoint.

## 2. Получить только обезличенный TEST-паспорт

Исходные фотографии найдены через VK API в июньских и июльских комментариях сообществ:

- `Полюбить Калининград Анонсы`;
- `Полюбить Калининград Афиша`.

Workflow сохраняет только производные изображения, где исходное рукописное ФИО закрыто, а вместо него нанесено синтетическое ФИО `ТЕСТ…`. Сырые фотографии не использовать и не публиковать.

Скачай артефакт последнего успешного run workflow `Amber VK passport fixture discovery`:

```bash
gh run list \
  --workflow amber-vk-passport-discovery.yml \
  --branch feat/amber-combine-jewelry-excursion \
  --status success \
  --limit 1

rm -rf .codex-artifacts/vk-passport-sanitized
gh run download <RUN_ID> \
  -n amber-vk-passport-sanitized \
  -D .codex-artifacts/vk-passport-sanitized
```

Проверь `contact-sheet-sanitized.jpg` глазами. Для E2E используй:

```text
.codex-artifacts/vk-passport-sanitized/fixtures/passport-test-01.jpg
```

На изображении должны сохраняться не менее пяти видимых печатей, а исходное ФИО не должно читаться.

## 3. Выпустить backend с обратимым TEST-сценарием

Текущий production backend `v109` ещё не содержит cleanup endpoint. Выпусти registration backend из свежей ветки обычным проектным способом, соблюдая `AGENTS.md`.

После выпуска проверь:

```text
GET /api/v1/health -> 200, ok=true
```

Не публикуй и не логируй секреты, cleanup token или содержимое фотографий.

## 4. Запустить реальную заявку через публичную страницу

```bash
cd site
npm ci
npx playwright install chromium

AMBER_E2E_FIXTURE=../.codex-artifacts/vk-passport-sanitized/fixtures/passport-test-01.jpg \
AMBER_E2E_ARTIFACT_DIR=../.codex-artifacts/amber-combine-production-application-e2e \
npm run test:amber-production-application
```

Скрипт уже выполняет полный сценарий:

1. открывает production-страницу;
2. проверяет дату `11 августа 11:00` и отсутствие публичной квоты;
3. вводит уникальные TEST-контакты;
4. загружает обезличенный реальный Паспорт участника фестиваля;
5. ждёт precheck с `5+` штампами;
6. отправляет заявку;
7. требует HTTP `201`, `status=accepted` и success UI;
8. требует `testApplication=true`;
9. проверяет, что email подавлен с причиной `test_application_suppressed`;
10. удаляет заявку через защищённый cleanup endpoint;
11. требует удаления application, orphan profile и приватных фото;
12. повторным DELETE подтверждает `404`, то есть заявка уже отсутствует;
13. при падении после создания заявки пытается выполнить emergency cleanup в `finally`.

Production email и Telegram для TEST-заявки отправляться не должны.

## 5. Проверить результат и отсутствие следов

Ожидаемый report:

```text
.codex-artifacts/amber-combine-production-application-e2e/report.json
```

Обязательные значения:

```json
{
  "status": "passed",
  "precheckStampCount": 5,
  "applicationStatus": "accepted",
  "emailSuppressed": true,
  "cleanupStatus": "deleted",
  "removedApplication": 1,
  "removedPrivateAssets": 1,
  "repeatedCleanupStatus": 404,
  "browserErrors": []
}
```

`precheckStampCount` и `removedPrivateAssets` могут быть больше указанного минимума.

После теста:

- production health снова `200`;
- страница и public event API снова `200`;
- тестового application code в системе не остаётся;
- приватный storage prefix этой заявки удалён;
- email и Telegram не отправлены;
- screenshot `01-precheck-ready.png` и `02-application-accepted.png` сохранены локально как QA-артефакты, но не публикуются в открытом репозитории.

## 6. Убрать временную инфраструктуру перед будущим merge

После успешного production E2E отдельным commit удали временные одноразовые файлы, которые не должны попасть в `main`:

- `.github/workflows/amber-e2e-preflight.yml`;
- `.github/workflows/apply-special-e2e-cleanup-patch.yml`;
- `scripts/apply_special_e2e_cleanup_patch.py`;
- каталог `release-assets/amber-combine/` — бинарные WebP уже лежат в `site/public`;
- `scripts/prepare_amber_combine_release.py` и `scripts/run_amber_combine_release.py` — интеграция уже завершена.

VK discovery/sanitizer и production E2E runner оцени отдельно: сохранить их как повторяемую закрытую QA-механику либо удалить перед merge. Ни сырые, ни обезличенные изображения в Git не добавлять.

## 7. Отчёт

В финальном отчёте укажи:

- новый branch HEAD;
- новый Fly release;
- результаты пяти backend-команд;
- run ID обезличенного VK artifact;
- фактическое число штампов в precheck и accepted response;
- application HTTP status;
- cleanup HTTP status и removal counts;
- подтверждение повторного `404`;
- подтверждение, что email/Telegram не отправлены;
- пути двух screenshots и `report.json`;
- production health после удаления;
- список удалённой временной инфраструктуры;
- PR остаётся draft, merge не выполнялся.
