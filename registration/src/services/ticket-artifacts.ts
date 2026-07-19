import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { TicketArtifacts } from '../types';
import type { StoragePublisher, TicketArtifactBundle } from '../lib/storage';
import festivalEventSpeakers from '../data/festival-event-speakers.json';

type TicketArtifactInput = {
  publicHash: string;
  eventSlug?: string | null;
  shortTicketId: string;
  ticketBaseUrl: string;
  ticketsPrefix: string;
  fullName: string;
  emailMasked: string;
  phoneMasked: string;
  title: string;
  speakerLabel?: string | null;
  startsAt: string;
  venueName: string;
  hallName: string;
  address: string;
  publicDetailsDeferred?: boolean;
  eventImageUrl?: string | null;
  ticketImageAsset?: string | null;
};

const ASSETS_ROOT = fileURLToPath(new URL('../assets/', import.meta.url));
const FESTIVAL_LOGO_PNG = path.join(ASSETS_ROOT, 'logos', 'logo-znanie-festival.png');
const FESTIVAL_MARK_PNG = path.join(ASSETS_ROOT, 'logos', 'logo-80-istorii-hero.png');
const TICKET_IMAGES_DIR = path.join(ASSETS_ROOT, 'ticket-event-images');
const SHARED_FONTS_ROOT = path.resolve(ASSETS_ROOT, '..', '..', '..', 'assets', 'fonts');
const CYGRE_REGULAR_FONT = path.join(SHARED_FONTS_ROOT, 'Cygre-Regular.woff2');
const CYGRE_BOLD_FONT = path.join(SHARED_FONTS_ROOT, 'Cygre-Bold.woff2');
const FAVORIT_BOOK_FONT = path.join(SHARED_FONTS_ROOT, 'FavoritPro-Book.otf');
const FAVORIT_MEDIUM_FONT = path.join(SHARED_FONTS_ROOT, 'FavoritPro-Medium.otf');
const FAVORIT_BOLD_FONT = path.join(SHARED_FONTS_ROOT, 'FavoritPro-Bold.otf');
const PDF_FONT_REGULAR_FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PDF_FONT_BOLD_FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// Pre-load logos as base64 data URIs so the HTML ticket is self-contained
// (no dependency on /shared-assets/ when opened from S3 or file://).
function loadPngDataUri(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:image/png;base64,${b64}`;
}

function getFontMimeType(filePath: string) {
  if (filePath.endsWith('.woff2')) {
    return 'font/woff2';
  }

  if (filePath.endsWith('.otf')) {
    return 'font/otf';
  }

  return 'application/octet-stream';
}

function loadFontDataUri(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${getFontMimeType(filePath)};base64,${b64}`;
}

const FESTIVAL_LOGO_DATA_URI = loadPngDataUri(FESTIVAL_LOGO_PNG);
const CYGRE_REGULAR_DATA_URI = loadFontDataUri(CYGRE_REGULAR_FONT);
const CYGRE_BOLD_DATA_URI = loadFontDataUri(CYGRE_BOLD_FONT);
const FAVORIT_BOOK_DATA_URI = loadFontDataUri(FAVORIT_BOOK_FONT);
const FAVORIT_MEDIUM_DATA_URI = loadFontDataUri(FAVORIT_MEDIUM_FONT);
const FAVORIT_BOLD_DATA_URI = loadFontDataUri(FAVORIT_BOLD_FONT);
const FESTIVAL_EVENT_SPEAKERS = festivalEventSpeakers as Record<string, string>;
const warnedFontFallbacks = new Set<string>();

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, '');
}

function buildTicketUrl(baseUrl: string, ticketsPrefix: string, publicHash: string) {
  return `${trimTrailingSlash(baseUrl)}/${ticketsPrefix.replace(/^\/+|\/+$/gu, '')}/${publicHash}/`;
}

function buildCalendarUrls(input: Pick<
  TicketArtifactInput,
  'ticketBaseUrl' | 'ticketsPrefix' | 'publicHash' | 'startsAt' | 'title' | 'venueName' | 'hallName' | 'address' | 'shortTicketId'
>) {
  const ticketUrl = buildTicketUrl(input.ticketBaseUrl, input.ticketsPrefix, input.publicHash);
  const pdfUrl = `${ticketUrl}ticket.pdf`;
  const icsUrl = `${ticketUrl}event.ics`;
  const googleCalendarUrl = new URL('https://calendar.google.com/calendar/render');
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
  const googleDates = `${startsAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}/${endsAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;

  googleCalendarUrl.searchParams.set('action', 'TEMPLATE');
  googleCalendarUrl.searchParams.set('text', input.title);
  googleCalendarUrl.searchParams.set('dates', googleDates);
  googleCalendarUrl.searchParams.set('location', `${input.venueName}, ${input.hallName}, ${input.address}`);
  googleCalendarUrl.searchParams.set('details', `Пригласительный билет № ${input.shortTicketId}. Распечатывать не требуется. Рассадка свободная. ${ticketUrl}`);

  return {
    ticketUrl,
    pdfUrl,
    icsUrl,
    googleCalendarUrl: googleCalendarUrl.toString(),
  };
}

function formatEventDate(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(isoValue));
}

function formatEventDateOnly(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(isoValue));
}

function formatEventTimeOnly(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(isoValue));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function buildAbsoluteUrl(baseUrl: string, relativePath: string | null | undefined) {
  if (!relativePath) {
    return null;
  }

  if (/^https?:\/\//u.test(relativePath)) {
    return relativePath;
  }

  return `${trimTrailingSlash(baseUrl)}${relativePath.startsWith('/') ? '' : '/'}${relativePath}`;
}

function resolveSpeakerLabel(input: Pick<TicketArtifactInput, 'eventSlug' | 'speakerLabel'>) {
  if (typeof input.speakerLabel === 'string' && input.speakerLabel.trim()) {
    return input.speakerLabel.trim();
  }

  if (typeof input.eventSlug === 'string' && input.eventSlug.trim()) {
    return FESTIVAL_EVENT_SPEAKERS[input.eventSlug.trim()] ?? '';
  }

  return '';
}

function resolveTicketImagePath(assetName: string | null | undefined) {
  if (!assetName) {
    return null;
  }

  const absolutePath = path.join(TICKET_IMAGES_DIR, assetName);
  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function buildHtml(input: TicketArtifactInput) {
  const { ticketUrl, pdfUrl, icsUrl, googleCalendarUrl } = buildCalendarUrls(input);
  const formattedDate = formatEventDate(input.startsAt);
  const dateOnly = formatEventDateOnly(input.startsAt);
  const timeOnly = formatEventTimeOnly(input.startsAt);
  const speakerLabel = resolveSpeakerLabel(input);
  // Use embedded data URIs so the ticket HTML is self-contained from any origin.
  // Fall back to /shared-assets/ paths if the PNG assets are not present.
  const festivalLogoUrl = FESTIVAL_LOGO_DATA_URI ?? '/shared-assets/logo-znanie-festival.svg';
  const cygreRegularUrl = CYGRE_REGULAR_DATA_URI ?? '/shared-assets/fonts/Cygre-Regular.woff2';
  const cygreBoldUrl = CYGRE_BOLD_DATA_URI ?? '/shared-assets/fonts/Cygre-Bold.woff2';
  const favoritBookUrl = FAVORIT_BOOK_DATA_URI ?? '/shared-assets/fonts/FavoritPro-Book.otf';
  const favoritMediumUrl = FAVORIT_MEDIUM_DATA_URI ?? '/shared-assets/fonts/FavoritPro-Medium.otf';
  const favoritBoldUrl = FAVORIT_BOLD_DATA_URI ?? '/shared-assets/fonts/FavoritPro-Bold.otf';
  const eventImageUrl = input.eventImageUrl || '';
  const deferredDetailsCopy = 'Дата и место будут опубликованы позже.';

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <title>Пригласительный — ${escapeHtml(input.title)}</title>
    <style>
      @font-face {
        font-family: "Cygre";
        src: url("${cygreRegularUrl}") format("woff2");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "Cygre";
        src: url("${cygreBoldUrl}") format("woff2");
        font-weight: 700;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "FavoritPro";
        src: url("${favoritBookUrl}") format("opentype");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "FavoritPro";
        src: url("${favoritMediumUrl}") format("opentype");
        font-weight: 500;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "FavoritPro";
        src: url("${favoritBoldUrl}") format("opentype");
        font-weight: 700;
        font-style: normal;
        font-display: swap;
      }

      :root {
        color-scheme: light;
        --paper: #f5ede1;
        --paper-soft: #fbf5ec;
        --card: rgba(255, 250, 244, 0.92);
        --ink: #16120d;
        --ink-soft: rgba(22, 18, 13, 0.68);
        --line: rgba(22, 18, 13, 0.12);
        --accent: #d84b31;
        --accent-deep: #962d1b;
        --shadow: 0 24px 64px rgba(27, 18, 12, 0.16);
        --radius-lg: 30px;
        --radius-md: 20px;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "FavoritPro", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at 12% 0%, rgba(216, 75, 49, 0.18), transparent 22rem),
          radial-gradient(circle at 84% 8%, rgba(18, 17, 14, 0.1), transparent 24rem),
          linear-gradient(180deg, #f7f1e8 0%, var(--paper) 44%, #f0e4d4 100%);
      }

      .shell {
        width: min(100% - 1.25rem, 980px);
        margin: 0 auto;
        padding: 24px 0 56px;
      }

      .ticket {
        overflow: hidden;
        border-radius: var(--radius-lg);
        background: var(--card);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }

      .hero {
        display: grid;
        gap: 24px;
        padding: 28px 28px 0;
      }

      .hero__brand {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }

      .hero__logos {
        display: block;
      }

      .hero__logos img {
        width: clamp(170px, 38vw, 320px);
        height: auto;
      }

      .hero__tagline {
        margin: 0;
        max-width: 17ch;
        color: rgba(22, 18, 13, 0.66);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.22;
        letter-spacing: 0.03em;
        text-wrap: balance;
      }

      .hero__eyebrow {
        margin: 0;
        color: var(--accent-deep);
        font-size: 12px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .hero__badge {
        display: inline-flex;
        align-items: center;
        min-height: 40px;
        padding: 0 16px;
        border-radius: 999px;
        border: 1px solid rgba(150, 45, 27, 0.15);
        background: rgba(216, 75, 49, 0.1);
        color: var(--accent-deep);
        font-size: 13px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        white-space: nowrap;
      }

      .hero__title {
        margin: 0;
        font-family: "Cygre", "Helvetica Neue", Arial, sans-serif;
        font-size: clamp(34px, 6vw, 62px);
        line-height: 0.92;
        letter-spacing: -0.03em;
        max-width: 11ch;
      }

      .hero__summary {
        margin: 0;
        max-width: 58ch;
        color: var(--ink-soft);
        font-size: 17px;
        line-height: 1.55;
      }

      .hero__speaker {
        display: inline-flex;
        align-items: center;
        max-width: min(100%, 54rem);
        margin: 0;
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid rgba(216, 75, 49, 0.18);
        background: rgba(216, 75, 49, 0.08);
        color: #2f241a;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.45;
      }

      .hero__meta {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }

      .hero__stat {
        padding: 14px 16px;
        border-radius: var(--radius-md);
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid var(--line);
      }

      .hero__stat-label {
        display: block;
        margin-bottom: 6px;
        color: rgba(22, 18, 13, 0.52);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .hero__stat-value {
        font-size: 16px;
        line-height: 1.35;
      }

      .hero__image {
        position: relative;
        min-height: 240px;
        margin-top: 4px;
        border-radius: 24px;
        overflow: hidden;
        background:
          linear-gradient(135deg, rgba(216, 75, 49, 0.28), rgba(24, 18, 14, 0.1)),
          #e9d8c4;
      }

      .hero__image img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .hero__image::after {
        content: "";
        position: absolute;
        inset: auto 0 0;
        height: 46%;
        background: linear-gradient(180deg, rgba(22, 18, 13, 0) 0%, rgba(22, 18, 13, 0.82) 100%);
      }

      .hero__image-caption {
        position: absolute;
        left: 18px;
        right: 18px;
        bottom: 18px;
        z-index: 1;
        color: white;
      }

      .hero__image-caption strong {
        display: block;
        font-family: "Cygre", "Helvetica Neue", Arial, sans-serif;
        font-size: clamp(24px, 4vw, 36px);
        line-height: 0.94;
        letter-spacing: -0.03em;
      }

      .hero__image-caption span {
        display: block;
        margin-top: 8px;
        color: rgba(255, 255, 255, 0.84);
        font-size: 14px;
        line-height: 1.45;
      }

      .body {
        display: grid;
        grid-template-columns: 1.25fr 0.95fr;
        gap: 18px;
        padding: 24px 28px 28px;
      }

      .panel {
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
        padding: 20px;
      }

      .panel__label {
        display: block;
        margin-bottom: 10px;
        color: rgba(22, 18, 13, 0.52);
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }

      .panel__value {
        margin: 0;
        font-size: 18px;
        line-height: 1.5;
      }

      .panel__value--person {
        font-family: "Cygre", "Helvetica Neue", Arial, sans-serif;
        font-size: clamp(26px, 4vw, 38px);
        line-height: 0.98;
      }

      .ticket-id {
        display: inline-flex;
        align-items: center;
        min-height: 56px;
        padding: 0 18px;
        border-radius: 20px;
        background: #17120d;
        color: white;
        font-family: "Cygre", "Helvetica Neue", Arial, sans-serif;
        font-size: clamp(26px, 5vw, 38px);
        letter-spacing: 0.1em;
      }

      .ticket-id-note {
        margin: 12px 0 0;
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.45;
      }

      .actions-stack {
        display: grid;
        gap: 16px;
      }

      .calendar-block {
        padding: 18px;
        border-radius: 24px;
        border: 1px solid rgba(150, 45, 27, 0.14);
        background: linear-gradient(180deg, rgba(255, 250, 244, 0.96) 0%, rgba(247, 239, 228, 0.96) 100%);
      }

      .actions-title {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(22, 18, 13, 0.52);
      }

      .actions-copy {
        margin: 0;
        color: var(--ink-soft);
        font-size: 15px;
        line-height: 1.5;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .actions--calendar {
        margin-top: 18px;
      }

      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 0 18px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: var(--accent);
        color: white;
        text-decoration: none;
        font-weight: 700;
        flex: 1 1 210px;
        box-shadow: 0 12px 30px rgba(150, 45, 27, 0.16);
      }

      .button--ghost {
        color: var(--ink);
        background: rgba(255, 255, 255, 0.88);
        border-color: rgba(22, 18, 13, 0.1);
        box-shadow: 0 10px 24px rgba(22, 18, 13, 0.08);
      }

      .footer-note {
        margin: 18px 0 0;
        color: var(--ink-soft);
        font-size: 14px;
        line-height: 1.55;
      }

      .footer-note a {
        color: inherit;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      @media (max-width: 860px) {
        .hero__meta,
        .body {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        .shell {
          width: min(100% - 0.75rem, 980px);
          padding-top: 12px;
        }

        .ticket {
          border-radius: 24px;
        }

        .hero,
        .body {
          padding-left: 18px;
          padding-right: 18px;
        }

        .hero {
          gap: 18px;
        }

        .hero__brand {
          gap: 12px;
        }

        .hero__image {
          min-height: 204px;
        }

        .panel__value {
          font-size: 16px;
        }

        .button {
          flex-basis: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <article class="ticket">
        <section class="hero">
          <div class="hero__brand">
            <div class="hero__logos">
              <img src="${festivalLogoUrl}" alt="Российское общество Знание. Фестиваль 80 историй о главном" />
            </div>
            <span class="hero__badge">Пригласительный</span>
          </div>
          <p class="hero__eyebrow">80 историй о главном</p>
          <h1 class="hero__title">${escapeHtml(input.title)}</h1>
          <p class="hero__summary">Сохраните пригласительный в телефоне и покажите на входе. Распечатывать не требуется, рассадка свободная.</p>
          ${speakerLabel ? `<p class="hero__speaker">Спикер: ${escapeHtml(speakerLabel)}</p>` : ''}
          <div class="hero__meta">
            ${input.publicDetailsDeferred ? `
            <div class="hero__stat" style="grid-column: 1 / -1;">
              <span class="hero__stat-label">Дата и место</span>
              <div class="hero__stat-value">${deferredDetailsCopy}</div>
            </div>` : `
            <div class="hero__stat">
              <span class="hero__stat-label">Дата</span>
              <div class="hero__stat-value">${escapeHtml(dateOnly)}</div>
            </div>
            <div class="hero__stat">
              <span class="hero__stat-label">Время</span>
              <div class="hero__stat-value">${escapeHtml(timeOnly)}</div>
            </div>
            <div class="hero__stat">
              <span class="hero__stat-label">Площадка</span>
              <div class="hero__stat-value">${escapeHtml(input.venueName)}</div>
            </div>
            <div class="hero__stat">
              <span class="hero__stat-label">Зал</span>
              <div class="hero__stat-value">${escapeHtml(input.hallName)}</div>
            </div>`}
          </div>
          <figure class="hero__image">
            ${eventImageUrl ? `<img src="${escapeHtml(eventImageUrl)}" alt="Визуальный образ события «${escapeHtml(input.title)}»" />` : ''}
            <figcaption class="hero__image-caption">
              <strong>Пригласительный № ${escapeHtml(input.shortTicketId)}</strong>
              <span>${input.publicDetailsDeferred ? deferredDetailsCopy : `${escapeHtml(formattedDate)} · ${escapeHtml(input.address)}`}</span>
            </figcaption>
          </figure>
        </section>

        <section class="body">
          <div class="panel">
            <span class="panel__label">Посетитель</span>
            <p class="panel__value panel__value--person">${escapeHtml(input.fullName)}</p>
            <p class="panel__value">${escapeHtml(input.emailMasked)}<br />${escapeHtml(input.phoneMasked)}</p>
          </div>
          <div class="panel">
            <span class="panel__label">Короткий номер пригласительного</span>
            <div class="ticket-id">${escapeHtml(input.shortTicketId)}</div>
            <p class="ticket-id-note">Покажите этот номер на входе или откройте пригласительный со страницы мероприятия. Рассадка свободная.</p>
          </div>
          <div class="panel">
            <span class="panel__label">${input.publicDetailsDeferred ? 'Дата и место' : 'Маршрут'}</span>
            <p class="panel__value">${input.publicDetailsDeferred ? deferredDetailsCopy : `${escapeHtml(input.venueName)}<br />${escapeHtml(input.hallName)}<br />${escapeHtml(input.address)}`}</p>
          </div>
          <div class="panel">
            <div class="actions-stack">
              <a class="button" href="${escapeHtml(pdfUrl)}">Скачать PDF</a>
              ${input.publicDetailsDeferred ? '' : `<div class="calendar-block">
                <p class="actions-title">📅 Добавить в календарь</p>
                <p class="actions-copy">Добавьте событие сейчас, чтобы не искать билет в день мероприятия.</p>
                <div class="actions actions--calendar">
                  <a class="button button--ghost" href="${escapeHtml(icsUrl)}">Android (ICS)</a>
                  <a class="button button--ghost" href="${escapeHtml(icsUrl)}">Календарь Apple</a>
                  <a class="button button--ghost" href="${escapeHtml(googleCalendarUrl)}" target="_blank" rel="noreferrer">Google</a>
                </div>
              </div>`}
            </div>
            <p class="footer-note">Распечатывать не требуется, рассадка свободная. Постоянная ссылка: <a href="${escapeHtml(ticketUrl)}">${escapeHtml(ticketUrl)}</a></p>
          </div>
        </section>
      </article>
    </main>
  </body>
</html>`;
}

function buildIcs(input: TicketArtifactInput) {
  if (input.publicDetailsDeferred) {
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//80 историй о главном//Registration Ticket//RU',
      'CALSCALE:GREGORIAN',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  }

  const start = new Date(input.startsAt);
  const end = new Date(start.getTime() + 90 * 60_000);
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const startIcs = start.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const endIcs = end.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const ticketUrl = buildTicketUrl(input.ticketBaseUrl, input.ticketsPrefix, input.publicHash);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//80 историй о главном//Registration Ticket//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${input.publicHash}@80istoriy.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${startIcs}`,
    `DTEND:${endIcs}`,
    `SUMMARY:${input.title.replace(/,/gu, '\\,')}`,
    `LOCATION:${`${input.venueName}, ${input.hallName}, ${input.address}`.replace(/,/gu, '\\,')}`,
    `DESCRIPTION:${`Пригласительный билет № ${input.shortTicketId}. Распечатывать не требуется. Рассадка свободная. ${ticketUrl}`.replace(/,/gu, '\\,')}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function setPdfFont(doc: PDFKit.PDFDocument, fontPath: string, fallback: string) {
  if (fs.existsSync(fontPath)) {
    doc.font(fontPath);
    return;
  }

  if (!warnedFontFallbacks.has(fontPath)) {
    warnedFontFallbacks.add(fontPath);
    console.warn(`ticket-artifacts: missing PDF font ${fontPath}, falling back to ${fallback}`);
  }
  doc.font(fallback);
}

function setPdfRegularFont(doc: PDFKit.PDFDocument) {
  setPdfFont(doc, FAVORIT_BOOK_FONT, PDF_FONT_REGULAR_FALLBACK);
}

function setPdfMediumFont(doc: PDFKit.PDFDocument) {
  setPdfFont(doc, FAVORIT_MEDIUM_FONT, PDF_FONT_REGULAR_FALLBACK);
}

function setPdfBoldFont(doc: PDFKit.PDFDocument) {
  setPdfFont(doc, FAVORIT_BOLD_FONT, PDF_FONT_BOLD_FALLBACK);
}

function setPdfDisplayFont(doc: PDFKit.PDFDocument) {
  // PDFKit/fontkit crashes while subsetting the bundled Cygre woff2 files.
  // Use the site's body-display companion in OTF so PDF artifacts stay stable.
  setPdfFont(doc, FAVORIT_BOLD_FONT, PDF_FONT_BOLD_FALLBACK);
}

function drawInfoCard(
  doc: PDFKit.PDFDocument,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    value: string;
    valueFontSize?: number;
    valueLineGap?: number;
  },
) {
  doc.save();
  doc.roundedRect(options.x, options.y, options.width, options.height, 18).fillAndStroke('#fffaf4', '#e4d7c6');
  doc.fillColor('#7a7066');
  setPdfBoldFont(doc);
  drawFixedText(doc, options.label.toUpperCase(), options.x + 14, options.y + 14, {
    fontSize: 10,
    width: options.width - 28,
    characterSpacing: 1.2,
  });
  doc.fillColor('#16120d');
  setPdfRegularFont(doc);
  drawFixedText(doc, options.value, options.x + 14, options.y + 34, {
    fontSize: options.valueFontSize ?? 12,
    width: options.width - 28,
    lineGap: options.valueLineGap ?? 3,
  });
  doc.restore();
}

function drawFixedText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  options: PDFKit.Mixins.TextOptions & {
    fontSize?: number;
  } = {},
) {
  const previousX = doc.x;
  const previousY = doc.y;
  const { fontSize, ...textOptions } = options;

  doc.x = 0;
  doc.y = 0;
  if (typeof fontSize === 'number') {
    doc.fontSize(fontSize);
  }
  doc.text(text, x, y, textOptions);
  doc.x = previousX;
  doc.y = previousY;
}

function measureTextHeight(
  doc: PDFKit.PDFDocument,
  options: {
    text: string;
    width: number;
    fontSize: number;
    lineGap?: number;
    font: 'regular' | 'medium' | 'bold' | 'display';
  },
) {
  doc.save();
  if (options.font === 'display') {
    setPdfDisplayFont(doc);
  } else if (options.font === 'bold') {
    setPdfBoldFont(doc);
  } else if (options.font === 'medium') {
    setPdfMediumFont(doc);
  } else {
    setPdfRegularFont(doc);
  }

  doc.fontSize(options.fontSize);
  const height = doc.heightOfString(options.text, {
    width: options.width,
    lineGap: options.lineGap ?? 0,
  });
  doc.restore();
  return height;
}

function measureInfoCardHeight(
  doc: PDFKit.PDFDocument,
  options: {
    width: number;
    value: string;
    minHeight?: number;
    valueFontSize?: number;
    valueLineGap?: number;
  },
) {
  const valueHeight = measureTextHeight(doc, {
    text: options.value,
    width: options.width - 28,
    fontSize: options.valueFontSize ?? 12,
    lineGap: options.valueLineGap ?? 3,
    font: 'regular',
  });
  return Math.max(options.minHeight ?? 78, 34 + valueHeight + 18);
}

function drawPanelSurface(
  doc: PDFKit.PDFDocument,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    stroke: string;
  },
) {
  doc.save();
  doc.roundedRect(options.x, options.y, options.width, options.height, 22).fillAndStroke(options.fill, options.stroke);
  doc.restore();
}

function drawPdfLinkButton(
  doc: PDFKit.PDFDocument,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    url: string;
    fillColor: string;
    borderColor: string;
    textColor: string;
    fontSize?: number;
  },
) {
  doc.save();
  doc.roundedRect(options.x, options.y, options.width, options.height, 12).fillAndStroke(options.fillColor, options.borderColor);
  doc.fillColor(options.textColor);
  setPdfBoldFont(doc);
  const lineHeight = doc.currentLineHeight();
  drawFixedText(doc, options.label, options.x + 8, options.y + Math.max(6, (options.height - lineHeight) / 2), {
    fontSize: options.fontSize ?? 10,
    width: options.width - 16,
    align: 'center',
  });
  doc.restore();
  doc.link(options.x, options.y, options.width, options.height, options.url);
}

function createPdfBuffer(input: TicketArtifactInput) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title: `Пригласительный — ${input.title}`,
        Author: '80 историй о главном',
      },
    });

    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const contentX = 42;
    const contentWidth = pageWidth - contentX * 2;
    const { ticketUrl, icsUrl, googleCalendarUrl } = buildCalendarUrls(input);
    const speakerLabel = resolveSpeakerLabel(input);
    const speakerText = speakerLabel ? `Спикер: ${speakerLabel}` : '';
    const cardGap = 14;
    const halfWidth = (contentWidth - cardGap) / 2;
    const lowerLeftWidth = contentWidth * 0.58;
    const lowerRightX = contentX + lowerLeftWidth + cardGap;
    const lowerRightWidth = contentWidth - lowerLeftWidth - cardGap;
    const titleFontSize = input.title.length > 105 ? 20 : input.title.length > 76 ? 23 : 27;

    doc.rect(0, 0, pageWidth, pageHeight).fill('#f5ede1');

    if (fs.existsSync(FESTIVAL_LOGO_PNG)) {
      doc.image(FESTIVAL_LOGO_PNG, contentX, 34, { fit: [248, 42] });
    }

    doc.save();
    doc.roundedRect(contentX, 98, 184, 30, 15).fill('#f3d6d0');
    doc.fillColor('#962d1b');
    setPdfMediumFont(doc);
    drawFixedText(doc, 'ПРИГЛАСИТЕЛЬНЫЙ', contentX + 14, 108, {
      fontSize: 10.4,
      width: 156,
      characterSpacing: 0.9,
    });
    doc.restore();

    setPdfDisplayFont(doc);
    doc.fillColor('#16120d');
    doc.fontSize(titleFontSize).text(input.title, contentX, 146, {
      width: contentWidth,
      lineGap: titleFontSize <= 20 ? 2 : 0,
    });

    setPdfRegularFont(doc);
    doc.fillColor('#544b42');
    doc.fontSize(12.2).text(
      'Сохраните пригласительный в телефоне и покажите на входе. Распечатывать не требуется, рассадка свободная.',
      contentX,
      doc.y + 10,
      {
        width: contentWidth,
        lineGap: 3,
      },
    );

    let cardsY = doc.y + 12;
    if (speakerText) {
      const speakerY = cardsY;
      const speakerHeight = Math.max(
        34,
        16 + measureTextHeight(doc, {
          text: speakerText,
          width: contentWidth - 28,
          fontSize: 11.2,
          lineGap: 2,
          font: 'medium',
        }),
      );
      doc.save();
      doc.roundedRect(contentX, speakerY, contentWidth, speakerHeight, 17).fillAndStroke('#f6e4dc', '#e6c4bc');
      doc.fillColor('#2f241a');
      setPdfMediumFont(doc);
      drawFixedText(doc, speakerText, contentX + 14, speakerY + 9, {
        fontSize: 11.2,
        width: contentWidth - 28,
        lineGap: 2,
      });
      doc.restore();
      cardsY = speakerY + speakerHeight + 10;
    }

    const topRowHeight = 70;
    const venueCardHeight = measureInfoCardHeight(doc, {
      width: halfWidth,
      value: input.venueName,
      minHeight: 76,
      valueFontSize: 11.2,
      valueLineGap: 2,
    });
    const hallCardHeight = measureInfoCardHeight(doc, {
      width: halfWidth,
      value: input.hallName,
      minHeight: 76,
      valueFontSize: 11.2,
      valueLineGap: 2,
    });
    const secondRowHeight = Math.max(venueCardHeight, hallCardHeight);

    if (input.publicDetailsDeferred) {
      drawInfoCard(doc, {
        x: contentX,
        y: cardsY,
        width: contentWidth,
        height: topRowHeight,
        label: 'Дата и место',
        value: 'Дата и место будут опубликованы позже.',
      });
    } else {
    drawInfoCard(doc, {
      x: contentX,
      y: cardsY,
      width: halfWidth,
      height: topRowHeight,
      label: 'Дата',
      value: formatEventDateOnly(input.startsAt),
    });
    drawInfoCard(doc, {
      x: contentX + halfWidth + cardGap,
      y: cardsY,
      width: halfWidth,
      height: topRowHeight,
      label: 'Время',
      value: formatEventTimeOnly(input.startsAt),
    });
    drawInfoCard(doc, {
      x: contentX,
      y: cardsY + topRowHeight + cardGap,
      width: halfWidth,
      height: secondRowHeight,
      label: 'Площадка',
      value: input.venueName,
      valueFontSize: 11.5,
      valueLineGap: 2,
    });
    drawInfoCard(doc, {
      x: contentX + halfWidth + cardGap,
      y: cardsY + topRowHeight + cardGap,
      width: halfWidth,
      height: secondRowHeight,
      label: 'Зал',
      value: input.hallName,
      valueFontSize: 11.5,
      valueLineGap: 2,
    });
    }

    const lowerY = input.publicDetailsDeferred
      ? cardsY + topRowHeight + 8
      : cardsY + topRowHeight + cardGap + secondRowHeight + 8;
    const contactText = `${input.emailMasked}\n${input.phoneMasked}`;
    const visitorHeight = Math.max(
      112,
      28
        + measureTextHeight(doc, {
            text: input.fullName,
            width: lowerLeftWidth - 36,
            fontSize: 20,
            lineGap: 2,
            font: 'display',
          })
        + 6
        + measureTextHeight(doc, {
            text: contactText,
            width: lowerLeftWidth - 36,
            fontSize: 11,
            lineGap: 2,
            font: 'regular',
          })
        + 14,
    );

    drawPanelSurface(doc, {
      x: contentX,
      y: lowerY,
      width: lowerLeftWidth,
      height: visitorHeight,
      fill: '#fffaf4',
      stroke: '#e4d7c6',
    });
    doc.fillColor('#7a7066');
    setPdfBoldFont(doc);
    drawFixedText(doc, 'ПОСЕТИТЕЛЬ', contentX + 18, lowerY + 16, {
      fontSize: 10,
      width: lowerLeftWidth - 36,
      characterSpacing: 1.2,
    });
    doc.fillColor('#16120d');
    setPdfDisplayFont(doc);
    drawFixedText(doc, input.fullName, contentX + 18, lowerY + 34, {
      fontSize: 20,
      width: lowerLeftWidth - 36,
      lineGap: 2,
    });
    setPdfRegularFont(doc);
    doc.fillColor('#544b42');
    drawFixedText(doc, contactText, contentX + 18, lowerY + visitorHeight - 34, {
      fontSize: 11,
      width: lowerLeftWidth - 36,
      lineGap: 2,
    });

    drawPanelSurface(doc, {
      x: lowerRightX,
      y: lowerY,
      width: lowerRightWidth,
      height: visitorHeight,
      fill: '#18120e',
      stroke: '#18120e',
    });
    doc.fillColor('#f5ede1');
    setPdfMediumFont(doc);
    drawFixedText(doc, 'КОРОТКИЙ НОМЕР ПРИГЛАСИТЕЛЬНОГО', lowerRightX + 18, lowerY + 16, {
      fontSize: 10,
      width: lowerRightWidth - 36,
      characterSpacing: 0.9,
    });
    setPdfDisplayFont(doc);
    drawFixedText(doc, input.shortTicketId, lowerRightX + 18, lowerY + 40, {
      fontSize: 28,
      width: lowerRightWidth - 36,
      characterSpacing: 3,
    });
    setPdfRegularFont(doc);
    drawFixedText(doc, 'Покажите этот номер на входе или откройте пригласительный на телефоне.', lowerRightX + 18, lowerY + 76, {
      fontSize: 9.5,
      width: lowerRightWidth - 36,
      lineGap: 1,
    });

    const addressY = lowerY + visitorHeight + 14;
    const routeValue = input.publicDetailsDeferred
      ? 'Дата и место будут опубликованы позже.'
      : `${input.venueName}\n${input.hallName}\n${input.address}`;
    const addressHeight = Math.max(
      70,
      28
        + measureTextHeight(doc, {
            text: routeValue,
            width: contentWidth - 36,
            fontSize: 11,
            lineGap: 2,
            font: 'regular',
          })
        + 12,
    );

    drawPanelSurface(doc, {
      x: contentX,
      y: addressY,
      width: contentWidth,
      height: addressHeight,
      fill: '#fffaf4',
      stroke: '#e4d7c6',
    });
    doc.fillColor('#7a7066');
    setPdfBoldFont(doc);
    drawFixedText(doc, input.publicDetailsDeferred ? 'ДАТА И МЕСТО' : 'ПЛОЩАДКА И АДРЕС', contentX + 18, addressY + 16, {
      fontSize: 10,
      width: contentWidth - 36,
      characterSpacing: 1.2,
    });
    doc.fillColor('#16120d');
    setPdfRegularFont(doc);
    drawFixedText(doc, routeValue, contentX + 18, addressY + 34, {
      fontSize: 11,
      width: contentWidth - 36,
      lineGap: 2,
    });

    const calendarY = addressY + addressHeight + 8;
    const calendarHeight = 56;
    const calendarButtonGap = 8;
    const calendarButtonWidth = (contentWidth - (calendarButtonGap * 2)) / 3;
    if (!input.publicDetailsDeferred) {
    drawPanelSurface(doc, {
      x: contentX,
      y: calendarY,
      width: contentWidth,
      height: calendarHeight,
      fill: '#f8efe4',
      stroke: '#d9c9b5',
    });
    doc.fillColor('#7a7066');
    setPdfBoldFont(doc);
    drawFixedText(doc, 'ДОБАВИТЬ В КАЛЕНДАРЬ', contentX + 18, calendarY + 12, {
      fontSize: 9.4,
      width: contentWidth - 36,
      characterSpacing: 1.2,
    });
    const buttonsY = calendarY + 26;
    drawPdfLinkButton(doc, {
      x: contentX,
      y: buttonsY,
      width: calendarButtonWidth,
      height: 24,
      label: 'Android (ICS)',
      url: icsUrl,
      fillColor: '#fffaf4',
      borderColor: '#e4d7c6',
      textColor: '#16120d',
      fontSize: 9.3,
    });
    drawPdfLinkButton(doc, {
      x: contentX + calendarButtonWidth + calendarButtonGap,
      y: buttonsY,
      width: calendarButtonWidth,
      height: 24,
      label: 'Календарь Apple',
      url: icsUrl,
      fillColor: '#fffaf4',
      borderColor: '#e4d7c6',
      textColor: '#16120d',
      fontSize: 8.9,
    });
    drawPdfLinkButton(doc, {
      x: contentX + (calendarButtonWidth + calendarButtonGap) * 2,
      y: buttonsY,
      width: calendarButtonWidth,
      height: 24,
      label: 'Google',
      url: googleCalendarUrl,
      fillColor: '#f3d6d0',
      borderColor: '#d9b0a8',
      textColor: '#962d1b',
      fontSize: 9.3,
    });
    }

    const footerY = input.publicDetailsDeferred ? calendarY + 4 : calendarY + calendarHeight + 4;
    setPdfRegularFont(doc);
    doc.fillColor('#962d1b');
    drawFixedText(doc, 'Открыть приглашение онлайн', contentX, footerY, {
      fontSize: 8.4,
      width: contentWidth,
    });
    doc.link(contentX, footerY, 144, 11, ticketUrl);
    doc.fillColor('#7a7066');
    drawFixedText(doc, 'Печать не требуется. Свободная рассадка.', contentX + 164, footerY, {
      fontSize: 8,
      width: contentWidth,
    });

    doc.end();
  });
}

function maskEmail(email: string) {
  const [local, domain = ''] = email.split('@');
  const safeLocal = local.length <= 2 ? `${local[0] ?? '*'}*` : `${local.slice(0, 2)}***`;
  const [domainName, domainZone = ''] = domain.split('.');
  const safeDomain = domainName.length <= 2 ? `${domainName[0] ?? '*'}*` : `${domainName.slice(0, 2)}***`;
  return `${safeLocal}@${safeDomain}${domainZone ? `.${domainZone}` : ''}`;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/u, '$1 $2 ***-**-$5');
}

export async function publishTicketArtifacts(
  publisher: StoragePublisher,
  input: {
    publicHash: string;
    eventSlug?: string | null;
    shortTicketId: string;
    ticketBaseUrl: string;
    ticketsPrefix: string;
    fullName: string;
    email: string;
    phone: string;
    title: string;
    speakerLabel?: string | null;
    startsAt: string;
    venueName: string;
    hallName: string;
    address: string;
    publicDetailsDeferred?: boolean;
    eventImageUrl?: string | null;
    ticketImageAsset?: string | null;
  },
): Promise<TicketArtifacts> {
  const htmlInput: TicketArtifactInput = {
    publicHash: input.publicHash,
    eventSlug: input.eventSlug ?? null,
    shortTicketId: input.shortTicketId,
    ticketBaseUrl: input.ticketBaseUrl,
    ticketsPrefix: input.ticketsPrefix,
    fullName: input.fullName,
    emailMasked: maskEmail(input.email),
    phoneMasked: maskPhone(input.phone),
    title: input.title,
    speakerLabel: input.speakerLabel ?? null,
    startsAt: input.startsAt,
    venueName: input.venueName,
    hallName: input.hallName,
    address: input.address,
    publicDetailsDeferred: input.publicDetailsDeferred,
    eventImageUrl: buildAbsoluteUrl(input.ticketBaseUrl, input.eventImageUrl ?? null),
    ticketImageAsset: input.ticketImageAsset ?? null,
  };

  const bundle: TicketArtifactBundle = {
    publicHash: input.publicHash,
    files: [
      {
        key: `${input.ticketsPrefix}/${input.publicHash}/index.html`,
        body: buildHtml(htmlInput),
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-store, max-age=0',
      },
      {
        key: `${input.ticketsPrefix}/${input.publicHash}/event.ics`,
        body: buildIcs(htmlInput),
        contentType: 'text/calendar; charset=utf-8',
        cacheControl: 'public, max-age=300',
      },
      {
        key: `${input.ticketsPrefix}/${input.publicHash}/ticket.pdf`,
        body: await createPdfBuffer(htmlInput),
        contentType: 'application/pdf',
        cacheControl: 'public, max-age=300',
      },
    ],
  };

  return publisher.publishTicketArtifacts(bundle);
}
