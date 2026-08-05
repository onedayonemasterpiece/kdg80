# Минимальная задача кодовому агенту: проверить и выпустить экскурсию

Модель: `Sol high`

Репозиторий: `onedayonemasterpiece/kdg80`

Рабочая ветка: `feat/amber-combine-jewelry-excursion`

Draft PR: `#1`

Не создавай новую ветку, не начинай реализацию заново и не переписывай тексты. Основная работа уже выполнена. Перед запуском прочитай `AGENTS.md` и `docs/amber-combine-jewelry-excursion-2026-08-11.md`.

Осталось выполнить подготовленный интеграционный скрипт, проверить результат и выпустить его.

## 1. Запустить подготовленную интеграцию

К задаче приложены два файла:

- `amber-combine-jewelry-production.webp` — `1200×900`;
- `amber-combine-jewelry-production-og.webp` — `1200×630`.

Из корня репозитория выполни, подставив фактические пути к вложениям:

```bash
python3 scripts/prepare_amber_combine_release.py \
  --source-image /path/to/amber-combine-jewelry-production.webp \
  --source-og /path/to/amber-combine-jewelry-production-og.webp
```

Скрипт уже содержит утверждённые изменения и должен только:

- положить два WebP-файла в `site/public/generated/special/` без перекодировки;
- заменить прошедший shipyard-hero на главной странице новым событием;
- добавить короткий раздел в канонический `specialregistration.md`;
- проверить отсутствие публичных формулировок `6 мест` / `6 победителей`.

Если скрипт остановился из-за несовпадения ожидаемого текста, не угадывай и не делай широкий рефакторинг: покажи точный diff/конфликт.

## 2. Проверить

```bash
cd registration
npm ci
npm run check
npm run test:special-draws
npm run test:special-social

cd ../site
npm ci
npm run build
```

Проведи Playwright visual gate:

- `/special/amber-combine-jewelry-excursion/` — desktop `1440×1000` и mobile `390×844`;
- `/special/` — desktop и mobile;
- главная — новый amber hero на desktop и mobile.

Проверь, что:

- изображения грузятся без искажения;
- в кропе видны мастер, инструмент и янтарь;
- нет горизонтального скролла;
- API загружает дату `11 августа 11:00`;
- форма доступна и не показывает число победителей;
- число победителей отсутствует в SSR-копирайте, карточке, hero, meta и Schema.org;
- старые special pages собираются без регрессий.

## 3. Выпустить

После зелёных проверок:

1. закоммить только связанные файлы в эту же ветку и push;
2. выпусти сначала registration backend, затем сайт;
3. не создавай production-заявку без необходимости; при технической необходимости ФИО должно начинаться с `ТЕСТ`;
4. проверь production health, публичный special-event endpoint, новую страницу, `/special/` и hero;
5. обнови draft PR `#1`, но не merge без команды владельца.

В отчёте дай commit SHA, результаты команд, пути скриншотов, Fly release backend, URL новой страницы и отдельное подтверждение, что число победителей не отображается на публичных поверхностях.
