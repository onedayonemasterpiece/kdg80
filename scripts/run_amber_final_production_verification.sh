#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${YC_ACCESS_KEY_ID:?YC_ACCESS_KEY_ID is required}"
: "${YC_SECRET_ACCESS_KEY:?YC_SECRET_ACCESS_KEY is required}"

FLY_APP="${FLY_APP:-znanie-kgd80-fest}"
SITE_URL='https://kgd80.ru/special/amber-combine-jewelry-excursion/'
EVENT_URL="https://${FLY_APP}.fly.dev/api/v1/special/events/amber-combine-jewelry-excursion?token=amber-combine-jewelry-20260811"
LEGACY_TEST_CODE='TEST-AMBER-MAIL-20260806191812-FF704C'

python3 - <<'PY'
from pathlib import Path

fixture = Path('registration/scripts/create-amber-test-application.ts')
text = fixture.read_text(encoding='utf-8')
text = text.replace(
    "const fullName = `TEST Проверка Почты ${timestamp.slice(-6)}`;",
    "const fullName = `ТЕСТ Проверка Почты ${timestamp.slice(-6)}`;",
)
fixture.write_text(text, encoding='utf-8')

cleanup = Path('registration/src/services/special-test-cleanup.ts')
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
PY

git config user.name onedayonemasterpiece
git config user.email estershow6@gmail.com
git add \
  registration/scripts/create-amber-test-application.ts \
  registration/src/services/special-test-cleanup.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: use valid TEST name and clean legacy fixture'
  git push origin HEAD:feat/amber-combine-jewelry-excursion
fi

pushd registration >/dev/null
npm ci
npm run check
npm run test:special-amber-eligibility
npm run test:special-test-cleanup
npm run test:special-test-draw-exclusion
npm run test:special-public-quota
npm run test:special-draws
popd >/dev/null

pushd site >/dev/null
npm ci
npm run build
popd >/dev/null

export AWS_ACCESS_KEY_ID="$YC_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$YC_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION='ru-central1'
S3_ENDPOINT='https://storage.yandexcloud.net'
S3_BUCKET='kgd80.ru'
PAGE='site/dist/special/amber-combine-jewelry-excursion/index.html'
test -f "$PAGE"

mapfile -t COMPILED_ASSETS < <(
  grep -oE '/_astro/[^"'"'"'<> ?]+' "$PAGE" | sed 's/[#?].*$//' | sort -u
)

for asset in "${COMPILED_ASSETS[@]}"; do
  source_path="site/dist${asset}"
  object_key="${asset#/}"
  test -f "$source_path" || continue
  content_type='application/octet-stream'
  case "$source_path" in
    *.css) content_type='text/css; charset=utf-8' ;;
    *.js|*.mjs) content_type='application/javascript; charset=utf-8' ;;
    *.svg) content_type='image/svg+xml' ;;
    *.woff2) content_type='font/woff2' ;;
    *.woff) content_type='font/woff' ;;
  esac
  aws --endpoint-url "$S3_ENDPOINT" s3api put-object \
    --bucket "$S3_BUCKET" \
    --key "$object_key" \
    --body "$source_path" \
    --content-type "$content_type" \
    --cache-control 'public, max-age=31536000, immutable' >/dev/null
done

aws --endpoint-url "$S3_ENDPOINT" s3api put-object \
  --bucket "$S3_BUCKET" \
  --key 'special/amber-combine-jewelry-excursion/index.html' \
  --body "$PAGE" \
  --content-type 'text/html; charset=utf-8' \
  --cache-control 'no-store, no-cache, must-revalidate, max-age=0' >/dev/null

LIVE_PAGE="/tmp/live-amber-page.html"
for attempt in {1..20}; do
  curl -fsS -H 'Cache-Control: no-cache' "${SITE_URL}?release=${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}" >"$LIVE_PAGE"
  if grep -q 'подать заявку могут только граждане Российской Федерации' "$LIVE_PAGE" \
    && ! grep -q 'name="russianCitizenshipConfirmed"' "$LIVE_PAGE" \
    && ! grep -q 'Подтверждаю, что являюсь гражданином Российской Федерации' "$LIVE_PAGE"; then
    break
  fi
  sleep 3
done
grep -q 'подать заявку могут только граждане Российской Федерации' "$LIVE_PAGE"
! grep -q 'name="russianCitizenshipConfirmed"' "$LIVE_PAGE"
! grep -q 'Подтверждаю, что являюсь гражданином Российской Федерации' "$LIVE_PAGE"

flyctl deploy --remote-only --app "$FLY_APP" --config fly.toml

for attempt in {1..30}; do
  if curl -fsS "https://${FLY_APP}.fly.dev/api/v1/health" >/tmp/amber-health.json; then
    break
  fi
  sleep 4
done
grep -q '"ok":true' /tmp/amber-health.json
curl -fsS "$EVENT_URL" >/tmp/amber-event.json
grep -q '"requiresRussianCitizenship":false' /tmp/amber-event.json
curl -fsSI "https://${FLY_APP}.fly.dev/shared-assets/email/amber-combine-jewelry-production.png" | grep -q '200'

set +e
LEGACY_OUTPUT="$(flyctl ssh console -a "$FLY_APP" -C "sh -lc 'cd /app/registration && AMBER_TEST_APPLICATION_CODE=$LEGACY_TEST_CODE npm run cleanup:amber-test-application'" 2>&1)"
LEGACY_STATUS=$?
set -e
printf '%s\n' "$LEGACY_OUTPUT"
if [[ $LEGACY_STATUS -eq 0 ]]; then
  grep -q '"cleaned":true' <<<"$LEGACY_OUTPUT"
  grep -q '"removedApplication":1' <<<"$LEGACY_OUTPUT"
elif grep -q 'TEST application not found' <<<"$LEGACY_OUTPUT"; then
  echo "Legacy TEST registration was already absent."
else
  echo "Legacy TEST cleanup failed." >&2
  exit "$LEGACY_STATUS"
fi

APPLICATION_OUTPUT="$(flyctl ssh console -a "$FLY_APP" -C "sh -lc 'cd /app/registration && AMBER_TEST_EMAIL=info@kgd80.ru npm run create:amber-test-application'" 2>&1)"
printf '%s\n' "$APPLICATION_OUTPUT"
APPLICATION_JSON="$(grep -E '^\{"applicationCode":' <<<"$APPLICATION_OUTPUT" | tail -n 1)"
test -n "$APPLICATION_JSON"
printf '%s' "$APPLICATION_JSON" >/tmp/amber-application.json

readarray -t APPLICATION_VALUES < <(python3 - <<'PY'
import json
p = json.load(open('/tmp/amber-application.json', encoding='utf-8'))
assert p['sent'] is True
assert p['target'] == 'info@kgd80.ru'
assert p['applicationCode'].startswith('TEST-AMBER-MAIL-')
print(p['applicationCode'])
print(p['messageId'])
print(p['subject'])
PY
)
APPLICATION_CODE="${APPLICATION_VALUES[0]}"
APPLICATION_MESSAGE_ID="${APPLICATION_VALUES[1]}"
APPLICATION_SUBJECT="${APPLICATION_VALUES[2]}"

WINNER_OUTPUT="$(flyctl ssh console -a "$FLY_APP" -C "sh -lc 'cd /app/registration && AMBER_WINNER_PREVIEW_EMAIL=info@kgd80.ru AMBER_WINNER_APPLICATION_CODE=\"$APPLICATION_CODE\" AMBER_WINNER_FULL_NAME=Максим npm run send:amber-winner-preview'" 2>&1)"
printf '%s\n' "$WINNER_OUTPUT"
WINNER_JSON="$(grep -E '^\{"sent":true' <<<"$WINNER_OUTPUT" | tail -n 1)"
test -n "$WINNER_JSON"
printf '%s' "$WINNER_JSON" >/tmp/amber-winner.json

readarray -t WINNER_VALUES < <(python3 - <<'PY'
import json
p = json.load(open('/tmp/amber-winner.json', encoding='utf-8'))
assert p['sent'] is True
assert p['target'] == 'info@kgd80.ru'
assert p['subject'].startswith('Вы победили в розыгрыше:')
assert 'ПРОЕКТ' not in p['subject'].upper()
assert p['cleanup']['removedApplication'] == 1
assert p['cleanup']['removedProfile'] == 1
print(p['messageId'])
print(p['subject'])
print(p['cleanup']['removedApplication'])
print(p['cleanup']['removedProfile'])
PY
)
WINNER_MESSAGE_ID="${WINNER_VALUES[0]}"
WINNER_SUBJECT="${WINNER_VALUES[1]}"

printf 'TEST_APPLICATION_CODE=%s\n' "$APPLICATION_CODE"
printf 'APPLICATION_EMAIL_MESSAGE_ID=%s\n' "$APPLICATION_MESSAGE_ID"
printf 'APPLICATION_EMAIL_SUBJECT=%s\n' "$APPLICATION_SUBJECT"
printf 'WINNER_EMAIL_MESSAGE_ID=%s\n' "$WINNER_MESSAGE_ID"
printf 'WINNER_EMAIL_SUBJECT=%s\n' "$WINNER_SUBJECT"
printf 'TEST_APPLICATION_REMOVED=%s\n' "${WINNER_VALUES[2]}"
printf 'TEST_PROFILE_REMOVED=%s\n' "${WINNER_VALUES[3]}"
printf 'LIVE_FORM_CITIZENSHIP_CONTROL=absent\n'
printf 'LIVE_FORM_CITIZENSHIP_NOTICE=present\n'
flyctl releases -a "$FLY_APP" --json | head -c 3000
