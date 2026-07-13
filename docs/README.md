# Документный роутинг

Этот файл нужен как быстрый индекс: куда идти в репозитории по каждому типу запроса, без повторного поиска по всей папке `docs/`.

## Быстрые входы

- Сайт фестиваля целиком: [docs/festival-landing-requirements.md](/workspaces/kdg80/docs/festival-landing-requirements.md)
- Система регистрации: [docs/registration-system-requirements.md](/workspaces/kdg80/docs/registration-system-requirements.md)
- Прямые event-links `/sobytiya/<slug>/` и landing-first routing: [docs/festival-landing-requirements.md](/workspaces/kdg80/docs/festival-landing-requirements.md)
- Share/copy прямой ссылки регистрации из формы и direct intent URLs: [docs/registration-system-requirements.md](/workspaces/kdg80/docs/registration-system-requirements.md)
- E2E-план регистрации: [docs/registration-system-e2e-plan.md](/workspaces/kdg80/docs/registration-system-e2e-plan.md)
- Gherkin source of truth: [docs/behave/registration-system.feature](/workspaces/kdg80/docs/behave/registration-system.feature)
- Ticket / invitation UI и PDF: [docs/ticket-design-brief.md](/workspaces/kdg80/docs/ticket-design-brief.md)
- Паспорт участника фестиваля и печатный A5-макет: [docs/participant-passport-requirements.md](/workspaces/kdg80/docs/participant-passport-requirements.md)
- Prompt для Claude Opus по финальному registration/PDF pass: [docs/prompts/opus-registration-visual-pdf-pass.md](/workspaces/kdg80/docs/prompts/opus-registration-visual-pdf-pass.md)
- Hero и визуальный канон: [docs/hero-requirements.md](/workspaces/kdg80/docs/hero-requirements.md)
- Тематические маршруты / страницы по интересам: [docs/po-interesam-requirements.md](/workspaces/kdg80/docs/po-interesam-requirements.md)
- Consent text и ПДн: [docs/registration-personal-data-consent.md](/workspaces/kdg80/docs/registration-personal-data-consent.md)
- VK social monitoring, VK ID и post-release message-code linking: [docs/features/social-activity-monitoring/requirements.md](/workspaces/kdg80/docs/features/social-activity-monitoring/requirements.md)

## Роутинг по операциям

- Secret preview deploy на Yandex Object Storage: [site/README.md](/workspaces/kdg80/site/README.md), [deploy-preview-to-yc.sh](/workspaces/kdg80/deploy-preview-to-yc.sh), [deploy-to-yc.sh](/workspaces/kdg80/deploy-to-yc.sh)
- Production-like E2E по secret preview: [scripts/run_registration_preview_e2e.py](/workspaces/kdg80/scripts/run_registration_preview_e2e.py)
- Артефакты запусков и скриншоты: [test-results](/workspaces/kdg80/test-results)
- Локальные секреты для YC, Telethon и тестов: `docs/.env` или корневой `.env` (локально, не в git)

## Схема выкладки и тестирования

1. Статический Astro-сайт собирается в `site/dist`.
2. Preview выкладывается в секретный prefix на основном домене `kgd80.ru/preview-.../`.
3. Root-absolute site URLs переписываются под preview-prefix.
4. Same-origin пути `/tickets/registration/states.json` и `/tickets/<public_hash>/` остаются на корне домена.
5. Browser E2E идёт не по `localhost`, а по secret preview на `kgd80.ru`, чтобы проверить реальное поведение manifest, CORS и ticket URLs.
6. Регистрационная форма отправляет POST в Fly backend.
7. Fly backend создаёт ticket artifacts в `/tickets/<public_hash>/`.
8. Telethon отдельно подтверждает telegram-side effects.
9. Скриншоты, summary и вспомогательные артефакты складываются в `test-results/<run-folder>/`.

## Быстрый runbook

Подготовка YC CLI, если в среде нет `aws`:

```sh
python3 -m venv /tmp/awscli-venv
/tmp/awscli-venv/bin/pip install awscli
```

Secret preview deploy:

```sh
PATH="/tmp/awscli-venv/bin:$PATH" YC_PUBLIC_BASE_URL="https://kgd80.ru" ./deploy-preview-to-yc.sh
```

Production-like E2E по выложенному preview:

```sh
.venv-e2e/bin/playwright install chromium
.venv-e2e/bin/python scripts/run_registration_preview_e2e.py --base-url "https://kgd80.ru/preview-<slug>/"
```

## Что смотреть при расхождениях

- Если secret preview открывается, а deploy падает на `ListObjectsV2`, смотреть [deploy-to-yc.sh](/workspaces/kdg80/deploy-to-yc.sh): preview path теперь должен работать и с put-only доступом.
- Если карточки на preview показывают правильные CTA, а live ticket page после регистрации показывает старые calendar labels, значит статический preview и registration backend на Fly.io сейчас на разных версиях.
- Если Telethon не подтверждает уведомления, сначала проверить не код, а доступность admin-сессии для текущего `TELEGRAM_AUTH_BUNDLE_S22`.
- Если нужно понять, почему событие публично показывает только дату и `Регистрация скоро откроется`, сначала проверить rules для production-start holdback по ИЦАЭ в [docs/festival-landing-requirements.md](/workspaces/kdg80/docs/festival-landing-requirements.md) и [docs/registration-system-requirements.md](/workspaces/kdg80/docs/registration-system-requirements.md).
