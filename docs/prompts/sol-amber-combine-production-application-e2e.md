# Минимальная задача кодовому агенту

Сделай только одно: замени GitHub Actions secret `FLY_API_TOKEN` на новый проверенный app-scoped deploy token для `znanie-kgd80-fest`.

```bash
unset FLY_API_TOKEN

TOKEN="$(flyctl tokens create deploy \
  --app znanie-kgd80-fest \
  --name github-amber-e2e \
  --expiry 24h)"

FLY_API_TOKEN="$TOKEN" flyctl status -a znanie-kgd80-fest >/dev/null
printf '%s' "$TOKEN" | gh secret set FLY_API_TOKEN \
  --repo onedayonemasterpiece/kdg80
unset TOKEN
```

Используй уже авторизованную локальную Fly-сессию. В команды, логи и ответ значение токена не выводи.

Не меняй код, ветку или PR. Не делай commit/push. Не запускай deploy или тесты.

Ответь только:

- `FLY_API_TOKEN заменён и проверен`;
- либо `FLY_API_TOKEN не заменён: <краткая причина>`.
