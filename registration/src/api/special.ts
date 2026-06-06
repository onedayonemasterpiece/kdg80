import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { StoragePublisher } from '../lib/storage';
import {
  createSpecialApplication,
  getSpecialEventPreview,
  SpecialApplicationError,
  type SpecialApplicationPayload,
} from '../services/special-applications';

type SpecialApiDeps = {
  db: Database.Database;
  consentVersion: string;
  consentTextHash: string;
  fingerprintSecret: string | null;
  publicKeyPemBase64: string | null;
  privateKeyPemBase64: string | null;
  storagePublisher: StoragePublisher;
};

const PREVIEW_SLUG = 'etudy-toy-vesny';
const PREVIEW_TOKEN = 'etudy-toy-vesny-debug-20260606';
const PREVIEW_PATH = `/special/${PREVIEW_TOKEN}`;

function noIndex(reply: { header: (name: string, value: string) => unknown }) {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  reply.header('Cache-Control', 'no-store');
}

function renderPreviewPage(eventJson: string) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Заявка на розыгрыш — Этюды той весны</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --surface: #fffdfa;
      --text: #1b1b1d;
      --muted: #5e6068;
      --line: #d8d1c4;
      --accent: #b51f2a;
      --accent-dark: #871721;
      --focus: #1d6f8f;
      --success: #0f6b4f;
      --error: #9e1c23;
      --shadow: 0 18px 45px rgba(38, 31, 23, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: Arial, "Helvetica Neue", sans-serif;
      color: var(--text);
      background:
        linear-gradient(90deg, rgba(181, 31, 42, 0.08), transparent 30%),
        var(--bg);
    }
    main {
      width: min(1080px, 100%);
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(360px, 1.1fr);
      gap: 28px;
      align-items: start;
    }
    .intro {
      padding: 28px 0;
    }
    .kicker {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 {
      margin: 0;
      max-width: 560px;
      font-size: clamp(36px, 6vw, 68px);
      line-height: 0.96;
      letter-spacing: 0;
    }
    .lead {
      max-width: 560px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
    }
    .event-meta {
      display: grid;
      gap: 10px;
      margin: 28px 0 0;
      padding: 0;
      list-style: none;
      font-size: 16px;
    }
    .event-meta li {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      flex: 0 0 auto;
    }
    form {
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 8px;
      padding: 24px;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0 0 22px;
    }
    legend, .group-title {
      display: block;
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 700;
    }
    label {
      display: grid;
      gap: 7px;
      font-size: 14px;
      font-weight: 700;
    }
    input[type="text"], input[type="email"], input[type="tel"] {
      width: 100%;
      min-height: 48px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px 13px;
      font: inherit;
      background: #fff;
      color: var(--text);
    }
    input:focus-visible, button:focus-visible, .upload:focus-within {
      outline: 3px solid color-mix(in srgb, var(--focus), white 20%);
      outline-offset: 2px;
    }
    .fields {
      display: grid;
      gap: 14px;
    }
    .dates {
      display: grid;
      gap: 10px;
    }
    .date-option {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 10px;
      align-items: center;
      min-height: 48px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      font-weight: 600;
    }
    .date-option input {
      width: 20px;
      height: 20px;
      margin: 0;
      accent-color: var(--accent);
    }
    .hint {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .upload {
      position: relative;
      display: grid;
      place-items: center;
      min-height: 170px;
      border: 2px dashed #b9ad9b;
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
      text-align: center;
      transition: border-color 160ms ease, background 160ms ease;
    }
    .upload:hover { border-color: var(--accent); background: #fff8f7; }
    .upload input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }
    .plus {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      margin: 0 auto 12px;
      background: var(--accent);
      color: #fff;
      font-size: 36px;
      line-height: 1;
    }
    .file-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .consent {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 10px;
      align-items: start;
      font-size: 14px;
      line-height: 1.4;
      font-weight: 500;
    }
    .consent input {
      width: 20px;
      height: 20px;
      margin: 0;
      accent-color: var(--accent);
    }
    button {
      width: 100%;
      min-height: 52px;
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: background 160ms ease, transform 120ms ease;
    }
    button:hover { background: var(--accent-dark); }
    button:active { transform: translateY(1px); }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .status {
      min-height: 24px;
      margin-top: 14px;
      font-size: 15px;
      line-height: 1.45;
    }
    .status[data-kind="success"] { color: var(--success); }
    .status[data-kind="error"] { color: var(--error); }
    .summary {
      margin-top: 14px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      font-size: 14px;
      line-height: 1.5;
    }
    @media (max-width: 820px) {
      main { padding: 20px 14px 36px; }
      .shell { grid-template-columns: 1fr; gap: 18px; }
      .intro { padding: 8px 0 0; }
      h1 { font-size: 42px; }
      .lead { font-size: 16px; }
      form { padding: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="shell">
      <section class="intro" aria-labelledby="page-title">
        <p class="kicker">Заявка на розыгрыш</p>
        <h1 id="page-title">Этюды той весны</h1>
        <p class="lead">Иммерсивный спектакль. Заявка не является билетом и не гарантирует проход; после проверки паспорта участника вы участвуете в розыгрыше выбранных дат.</p>
        <ul class="event-meta">
          <li><span class="dot" aria-hidden="true"></span><span>11 июня 18:00 Южный Вокзал</span></li>
          <li><span class="dot" aria-hidden="true"></span><span>16 июня Южный Вокзал</span></li>
          <li><span class="dot" aria-hidden="true"></span><span>21 июня Южный Вокзал</span></li>
        </ul>
      </section>
      <form id="special-form" data-testid="special-form">
        <input type="hidden" name="website" autocomplete="off">
        <fieldset>
          <legend>Даты показа</legend>
          <div class="dates" id="dates"></div>
        </fieldset>
        <div class="fields">
          <label>ФИО
            <input name="fullName" type="text" autocomplete="name" required>
          </label>
          <label>Email
            <input name="email" type="email" autocomplete="email" required>
          </label>
          <label>Телефон
            <input name="phone" type="tel" autocomplete="tel" required>
          </label>
        </div>
        <fieldset>
          <span class="group-title">Паспорт участника фестиваля</span>
          <label class="upload">
            <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple required data-testid="photo-input">
            <span>
              <span class="plus" aria-hidden="true">+</span>
              <strong>Приложите фотографию паспорта участника фестиваля</strong>
              <span class="hint">с заполненным полем ФИО. Если у вас несколько экземпляров, приложите несколько фотографий. Фотографии принимаются только с лицевой стороны.</span>
            </span>
          </label>
          <p class="hint">У вас должно быть не менее 5 штампов о посещении событий фестиваля.</p>
          <div class="file-list" id="file-list" aria-live="polite"></div>
        </fieldset>
        <label class="consent">
          <input name="consentAccepted" type="checkbox" required>
          <span>Согласен на обработку персональных данных, загрузку фотографий паспорта участника фестиваля и автоматическую OCR/LLM-проверку изображений для участия в розыгрыше.</span>
        </label>
        <button type="submit" data-testid="submit-special">Отправить заявку</button>
        <div class="status" id="status" role="status" aria-live="polite"></div>
        <div class="summary" id="summary" hidden></div>
      </form>
    </div>
  </main>
  <script>
    const SPECIAL_EVENT = ${eventJson};
    const TOKEN = ${JSON.stringify(PREVIEW_TOKEN)};
    const form = document.querySelector('#special-form');
    const dates = document.querySelector('#dates');
    const photosInput = document.querySelector('#photos');
    const fileList = document.querySelector('#file-list');
    const statusEl = document.querySelector('#status');
    const summaryEl = document.querySelector('#summary');
    const submit = document.querySelector('[data-testid="submit-special"]');

    dates.innerHTML = SPECIAL_EVENT.showings.map((showing, index) => \`
      <label class="date-option">
        <input type="checkbox" name="selectedShowingSlugs" value="\${showing.slug}" \${index === 0 ? 'checked' : ''}>
        <span>\${showing.displayLabel}\${showing.timeIsFinal ? '' : ' · тестовая дата'}</span>
      </label>
    \`).join('');

    photosInput.addEventListener('change', () => {
      const files = [...photosInput.files];
      fileList.textContent = files.length ? files.map((file) => file.name).join(', ') : '';
    });

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('file_read_failed'));
        reader.onload = () => {
          const text = String(reader.result || '');
          resolve(text.includes(',') ? text.split(',').pop() : text);
        };
        reader.readAsDataURL(file);
      });
    }

    function setStatus(kind, text) {
      statusEl.dataset.kind = kind;
      statusEl.textContent = text;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      summaryEl.hidden = true;
      summaryEl.textContent = '';
      setStatus('', '');
      submit.disabled = true;
      submit.textContent = 'Проверяем фото...';

      try {
        const formData = new FormData(form);
        const files = [...photosInput.files];
        const photos = await Promise.all(files.map(async (file) => ({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          dataBase64: await fileToBase64(file),
        })));
        const payload = {
          token: TOKEN,
          eventSlug: SPECIAL_EVENT.slug,
          selectedShowingSlugs: formData.getAll('selectedShowingSlugs'),
          fullName: String(formData.get('fullName') || ''),
          email: String(formData.get('email') || ''),
          phone: String(formData.get('phone') || ''),
          consentAccepted: formData.get('consentAccepted') === 'on',
          website: String(formData.get('website') || ''),
          photos,
        };
        const response = await fetch('/api/v1/special/applications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.message || 'Не удалось отправить заявку.');
        }

        if (data.status === 'accepted') {
          setStatus('success', 'Заявка принята к розыгрышу. Это не билет; результаты будут подведены отдельно.');
        } else {
          setStatus('error', data.rejectionReason || 'Заявка не допущена к розыгрышу.');
        }
        summaryEl.hidden = false;
        summaryEl.innerHTML = [
          \`Код заявки: <strong>\${data.applicationCode}</strong>\`,
          \`Штампы: <strong>\${data.scoring.stampCount}</strong>\`,
          \`Баллы: <strong>\${data.scoring.score}</strong>\`,
          \`Выбрано дат: <strong>\${data.selectedShowings.length}</strong>\`,
        ].join('<br>');
      } catch (error) {
        setStatus('error', error instanceof Error ? error.message : 'Не удалось отправить заявку.');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Отправить заявку';
      }
    });
  </script>
</body>
</html>`;
}

export async function registerSpecialApi(app: FastifyInstance, deps: SpecialApiDeps) {
  app.get(PREVIEW_PATH, async (_request, reply) => {
    const event = getSpecialEventPreview(deps.db, PREVIEW_SLUG, PREVIEW_TOKEN);
    if (!event) {
      reply.code(404);
      return 'Preview not found';
    }

    noIndex(reply);
    reply.type('text/html; charset=utf-8');
    return renderPreviewPage(JSON.stringify(event).replace(/</gu, '\\u003c'));
  });

  app.get('/api/v1/special/events/:slug', async (request, reply) => {
    const slug = (request.params as Record<string, string>).slug;
    const token = typeof request.query === 'object' && request.query
      ? String((request.query as Record<string, unknown>).token ?? '')
      : '';
    const event = getSpecialEventPreview(deps.db, slug, token);
    noIndex(reply);

    if (!event) {
      reply.code(404);
      return { error: 'special_event_not_found' };
    }

    return event;
  });

  app.post('/api/v1/special/applications', {
    bodyLimit: 14 * 1024 * 1024,
    config: {
      rateLimit: {
        max: 4,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    noIndex(reply);

    if (!deps.fingerprintSecret || !deps.publicKeyPemBase64) {
      reply.code(503);
      return {
        error: 'special_registration_not_ready',
        message: 'Заявка на розыгрыш пока не настроена на сервере.',
      };
    }

    try {
      const created = await createSpecialApplication(request.body as SpecialApplicationPayload, {
        db: deps.db,
        consentVersion: deps.consentVersion,
        consentTextHash: deps.consentTextHash,
        fingerprintSecret: deps.fingerprintSecret,
        publicKeyPemBase64: deps.publicKeyPemBase64,
        privateKeyPemBase64: deps.privateKeyPemBase64,
        storagePublisher: deps.storagePublisher,
        sourceIp: request.ip,
        userAgent: request.headers['user-agent'],
      });

      reply.code(201);
      return created;
    } catch (error) {
      if (error instanceof SpecialApplicationError) {
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error }, 'special_application_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось отправить заявку. Попробуйте ещё раз чуть позже.',
      };
    }
  });
}

export { PREVIEW_PATH as SPECIAL_PREVIEW_PATH };
