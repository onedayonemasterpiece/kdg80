import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { StoragePublisher } from '../lib/storage';
import {
  checkSpecialApplicationPhotos,
  createSpecialApplication,
  getSpecialEventPreview,
  SpecialApplicationError,
  type SpecialApplicationPayload,
  type SpecialPhotoCheckPayload,
  type SpecialPhotoPayload,
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

type MultipartPart = {
  name: string;
  fileName: string | null;
  contentType: string;
  data: Buffer;
};

const PREVIEW_SLUG = 'etudy-toy-vesny';
const PREVIEW_TOKEN = 'etudy-toy-vesny-debug-20260606';
const PREVIEW_PATH = `/special/${PREVIEW_TOKEN}`;
const PREVIEW_PUBLIC_URL = process.env.SPECIAL_PREVIEW_PUBLIC_URL?.trim()
  || 'https://kgd80.ru/preview-special-etudy-20260608/special/etudy-toy-vesny-debug-20260606/';

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_MULTIPART_PARTS = readPositiveInteger(process.env.SPECIAL_MAX_MULTIPART_PARTS, 24);
const MAX_MULTIPART_PHOTO_PARTS = readPositiveInteger(process.env.SPECIAL_MAX_MULTIPART_PHOTO_PARTS, 5);
const MAX_MULTIPART_FIELD_BYTES = readPositiveInteger(process.env.SPECIAL_MAX_MULTIPART_FIELD_BYTES, 32 * 1024);
const SPECIAL_BODY_LIMIT_BYTES = readPositiveInteger(process.env.SPECIAL_BODY_LIMIT_BYTES, 90 * 1024 * 1024);

function noIndex(reply: { header: (name: string, value: string) => unknown }) {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  reply.header('Cache-Control', 'no-store');
}

function parseHeaderParameters(value: string) {
  const params: Record<string, string> = {};
  for (const segment of value.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = segment.trim().split('=');
    if (!rawKey || !rawValueParts.length) {
      continue;
    }
    const rawValue = rawValueParts.join('=').trim();
    params[rawKey.toLowerCase()] = rawValue.replace(/^"|"$/gu, '');
  }
  return params;
}

function parseMultipartBody(contentType: string, body: Buffer): MultipartPart[] {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/iu);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    throw new SpecialApplicationError(400, 'invalid_multipart', 'Не удалось прочитать загруженные файлы.');
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) {
    throw new SpecialApplicationError(400, 'invalid_multipart', 'Не удалось прочитать загруженные файлы.');
  }

  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '--') {
      break;
    }
    if (body.subarray(partStart, partStart + 2).toString('ascii') === '\r\n') {
      partStart += 2;
    }

    const nextCursor = body.indexOf(delimiter, partStart);
    if (nextCursor < 0) {
      break;
    }

    let part = body.subarray(partStart, nextCursor);
    if (part.length >= 2 && part.subarray(part.length - 2).toString('ascii') === '\r\n') {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd >= 0) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const headers: Record<string, string> = {};
      for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }

      const disposition = headers['content-disposition'] || '';
      const dispositionParams = parseHeaderParameters(disposition);
      const name = dispositionParams.name;
      if (name) {
        if (parts.length >= MAX_MULTIPART_PARTS) {
          throw new SpecialApplicationError(400, 'too_many_multipart_parts', 'Слишком много полей и файлов в запросе.');
        }
        if (
          dispositionParams.filename === undefined
          && name !== 'photoData'
          && data.length > MAX_MULTIPART_FIELD_BYTES
        ) {
          throw new SpecialApplicationError(400, 'multipart_field_too_large', 'Одно из текстовых полей слишком большое.');
        }
        parts.push({
          name,
          fileName: dispositionParams.filename || null,
          contentType: headers['content-type'] || 'application/octet-stream',
          data,
        });
      }
    }

    cursor = nextCursor;
  }

  return parts;
}

function multipartField(parts: MultipartPart[], name: string) {
  const part = parts.find((item) => item.name === name && item.fileName === null);
  return part ? part.data.toString('utf8') : '';
}

function multipartFields(parts: MultipartPart[], name: string) {
  return parts
    .filter((item) => item.name === name && item.fileName === null)
    .map((item) => item.data.toString('utf8'));
}

function multipartPartLogSummary(parts: MultipartPart[]) {
  return parts.map((part) => ({
    name: part.name,
    hasFile: part.fileName !== null,
    fileName: part.fileName,
    contentType: part.contentType,
    bytes: part.data.length,
  }));
}

function photoPayloadLogSummary(photos: SpecialPhotoPayload[]) {
  return photos.map((photo) => ({
    fileName: photo.fileName,
    contentType: photo.contentType,
    base64Chars: photo.dataBase64.length,
  }));
}

function photosFromMultipart(parts: MultipartPart[]) {
  const photoPartCount = parts.filter((item) => (
    (item.name === 'photos' && item.fileName !== null && item.data.length > 0)
    || (item.name === 'photoData' && item.fileName === null && item.data.length > 0)
  )).length;
  if (photoPartCount > MAX_MULTIPART_PHOTO_PARTS) {
    throw new SpecialApplicationError(400, 'too_many_photos', `Можно загрузить не больше ${MAX_MULTIPART_PHOTO_PARTS} фото за одну проверку.`);
  }

  return parts
    .map((item) => {
      if (item.name === 'photos' && item.fileName !== null && item.data.length > 0) {
        return {
          fileName: item.fileName || 'passport-photo',
          contentType: item.contentType || 'application/octet-stream',
          dataBase64: item.data.toString('base64'),
        };
      }

      if (item.name !== 'photoData' || item.fileName !== null) {
        return null;
      }

      try {
        const parsed = JSON.parse(item.data.toString('utf8')) as Partial<SpecialPhotoPayload>;
        return {
          fileName: String(parsed.fileName || 'passport-photo'),
          contentType: String(parsed.contentType || 'application/octet-stream'),
          dataBase64: String(parsed.dataBase64 || ''),
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is SpecialPhotoPayload => Boolean(item?.dataBase64));
}

function multipartPhotoCheckPayload(contentType: string, body: Buffer): SpecialPhotoCheckPayload {
  return multipartPhotoCheckPayloadFromParts(parseMultipartBody(contentType, body));
}

function multipartPhotoCheckPayloadFromParts(parts: MultipartPart[]): SpecialPhotoCheckPayload {
  return {
    token: multipartField(parts, 'token'),
    eventSlug: multipartField(parts, 'eventSlug'),
    fullName: multipartField(parts, 'fullName'),
    email: multipartField(parts, 'email'),
    phone: multipartField(parts, 'phone'),
    website: multipartField(parts, 'website'),
    photos: photosFromMultipart(parts),
  };
}

function multipartApplicationPayload(contentType: string, body: Buffer): SpecialApplicationPayload {
  return multipartApplicationPayloadFromParts(parseMultipartBody(contentType, body));
}

function multipartApplicationPayloadFromParts(parts: MultipartPart[]): SpecialApplicationPayload {
  return {
    token: multipartField(parts, 'token'),
    eventSlug: multipartField(parts, 'eventSlug'),
    selectedShowingSlugs: multipartFields(parts, 'selectedShowingSlugs'),
    fullName: multipartField(parts, 'fullName'),
    email: multipartField(parts, 'email'),
    phone: multipartField(parts, 'phone'),
    consentAccepted: multipartField(parts, 'consentAccepted') === 'on' || multipartField(parts, 'consentAccepted') === 'true',
    website: multipartField(parts, 'website'),
    vkAuthToken: multipartField(parts, 'vkAuthToken'),
    photos: photosFromMultipart(parts),
  };
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
    @font-face {
      font-family: "Cygre";
      src: url("/shared-assets/fonts/Cygre-Regular.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "Cygre";
      src: url("/shared-assets/fonts/Cygre-SemiBold.woff2") format("woff2");
      font-weight: 600;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "Cygre";
      src: url("/shared-assets/fonts/Cygre-Bold.woff2") format("woff2");
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "FavoritPro";
      src: url("/shared-assets/fonts/FavoritPro-Book.otf") format("opentype");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "FavoritPro";
      src: url("/shared-assets/fonts/FavoritPro-Medium.otf") format("opentype");
      font-weight: 500;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "FavoritPro";
      src: url("/shared-assets/fonts/FavoritPro-Bold.otf") format("opentype");
      font-weight: 800;
      font-style: normal;
      font-display: swap;
    }
    :root {
      color-scheme: light;
      --paper: #f1eadf;
      --paper-soft: #f7f1e8;
      --paper-strong: #fcf6ed;
      --paper-deep: #e0d2c0;
      --ink: #12110e;
      --ink-soft: #554f48;
      --ink-muted: #8c847a;
      --line: rgba(18, 17, 14, 0.12);
      --line-strong: rgba(18, 17, 14, 0.2);
      --accent: #d84b31;
      --accent-deep: #9b2e1a;
      --accent-soft: rgba(216, 75, 49, 0.12);
      --success: #236144;
      --error: #a52f20;
      --shadow: 0 18px 42px rgba(26, 21, 16, 0.08);
      --shadow-strong: 0 34px 84px rgba(18, 15, 12, 0.18);
      --radius-sm: 12px;
      --radius-md: 20px;
      --radius-lg: 30px;
      --font-body: "FavoritPro", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-display: "Cygre", "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    html {
      -webkit-text-size-adjust: 100%;
    }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: var(--font-body);
      font-size: 16px;
      line-height: 1.5;
      color: var(--ink);
      background:
        linear-gradient(180deg, #f7f1e8 0%, #f1eadf 46%, #f6efe6 100%);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    button, input {
      font: inherit;
    }
    .page {
      position: relative;
      min-height: 100dvh;
      overflow: hidden;
      isolation: isolate;
    }
    .page::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background:
        linear-gradient(115deg, rgba(252, 246, 237, 0.96) 0%, rgba(252, 246, 237, 0.72) 48%, rgba(216, 75, 49, 0.1) 100%),
        linear-gradient(180deg, rgba(18, 17, 14, 0.04), transparent 34%);
    }
    main {
      position: relative;
      z-index: 1;
      width: min(1180px, 100%);
      margin: 0 auto;
      padding: 26px 20px 52px;
    }
    .topbar {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 26px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      width: 190px;
      max-width: 58vw;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--accent);
      box-shadow: 0 16px 34px rgba(155, 46, 26, 0.2);
    }
    .brand img {
      display: block;
      width: 100%;
      height: auto;
    }
    .preview-pill {
      display: inline-flex;
      align-items: center;
      min-height: 36px;
      padding: 0 14px;
      border: 1px solid rgba(18, 17, 14, 0.1);
      border-radius: 999px;
      background: rgba(255, 252, 248, 0.72);
      color: var(--ink-soft);
      font-size: 13px;
      font-weight: 700;
    }
    .shell {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(410px, 1.08fr);
      gap: 30px;
      align-items: start;
    }
    .intro {
      display: grid;
      gap: 24px;
      padding: 10px 0;
    }
    .kicker {
      margin: 0 0 12px;
      color: var(--accent-deep);
      font-size: 14px;
      line-height: 1.4;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 560px;
      font-family: var(--font-display);
      font-size: 72px;
      line-height: 0.94;
      letter-spacing: 0;
      font-weight: 700;
    }
    .lead {
      max-width: 520px;
      margin: 20px 0 0;
      color: var(--ink-soft);
      font-size: 18px;
      line-height: 1.5;
    }
    .event-meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .event-meta li {
      min-height: 120px;
      display: grid;
      align-content: space-between;
      gap: 12px;
      padding: 16px;
      border: 1px solid rgba(18, 17, 14, 0.08);
      border-radius: var(--radius-md);
      background: rgba(255, 252, 248, 0.68);
      box-shadow: 0 14px 30px rgba(18, 17, 14, 0.05);
    }
    .event-meta strong {
      display: block;
      font-family: var(--font-display);
      font-size: 30px;
      line-height: 0.95;
      font-weight: 700;
    }
    .event-meta span {
      color: var(--ink-soft);
      font-size: 14px;
      line-height: 1.35;
      font-weight: 500;
    }
    .note-panel {
      max-width: 560px;
      padding: 18px 20px;
      border: 1px solid rgba(155, 46, 26, 0.14);
      border-radius: var(--radius-md);
      background: rgba(216, 75, 49, 0.08);
      color: var(--ink-soft);
      font-size: 15px;
      line-height: 1.5;
    }
    .note-panel strong {
      color: var(--accent-deep);
    }
    form {
      display: grid;
      gap: 18px;
      padding: 24px;
      border: 1px solid rgba(18, 17, 14, 0.08);
      border-radius: var(--radius-lg);
      background:
        linear-gradient(180deg, rgba(252, 246, 237, 0.98), rgba(247, 241, 232, 0.96));
      box-shadow: var(--shadow-strong);
    }
    .form-head {
      display: grid;
      gap: 8px;
      padding-bottom: 18px;
      border-bottom: 1px solid rgba(18, 17, 14, 0.08);
    }
    .form-head h2 {
      margin: 0;
      font-family: var(--font-display);
      font-size: 34px;
      line-height: 1;
      letter-spacing: 0;
    }
    .form-head p {
      margin: 0;
      color: var(--ink-soft);
      font-size: 15px;
      line-height: 1.45;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
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
      min-height: 52px;
      border: 1px solid rgba(18, 17, 14, 0.12);
      border-radius: var(--radius-sm);
      padding: 0 15px;
      font: inherit;
      background: rgba(255, 252, 248, 0.92);
      color: var(--ink);
      transition: border-color 150ms ease, box-shadow 150ms ease, background-color 150ms ease;
    }
    input:focus-visible, button:focus-visible, .upload:focus-within {
      outline: 2px solid rgba(184, 63, 47, 0.35);
      outline-offset: 2px;
    }
    input[type="text"]:focus-visible,
    input[type="email"]:focus-visible,
    input[type="tel"]:focus-visible {
      border-color: rgba(184, 63, 47, 0.3);
      box-shadow: 0 0 0 3px rgba(184, 63, 47, 0.08);
      background: rgba(255, 252, 248, 0.98);
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
      grid-template-columns: 24px 1fr;
      gap: 12px;
      align-items: center;
      min-height: 62px;
      padding: 13px 14px;
      border: 1px solid rgba(18, 17, 14, 0.1);
      border-radius: var(--radius-sm);
      background: rgba(255, 252, 248, 0.78);
      font-weight: 700;
      cursor: pointer;
      transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease;
    }
    .date-option:hover {
      transform: translateY(-1px);
      border-color: rgba(155, 46, 26, 0.22);
      background: rgba(255, 252, 248, 0.98);
    }
    .date-option:has(input:checked) {
      border-color: rgba(155, 46, 26, 0.4);
      background: rgba(216, 75, 49, 0.1);
      box-shadow: inset 0 0 0 1px rgba(155, 46, 26, 0.18);
    }
    .date-option__main {
      display: grid;
      gap: 4px;
    }
    .date-option.is-disabled {
      cursor: not-allowed;
      color: var(--ink-muted);
      background: rgba(255, 252, 248, 0.42);
      border-color: rgba(18, 17, 14, 0.08);
      box-shadow: none;
    }
    .date-option.is-disabled:hover {
      transform: none;
      background: rgba(255, 252, 248, 0.42);
      border-color: rgba(18, 17, 14, 0.08);
    }
    .date-option__meta {
      color: var(--ink-muted);
      font-size: 13px;
      line-height: 1.25;
      font-weight: 500;
    }
    .date-option__tag {
      color: var(--accent-deep);
    }
    .date-option__closed {
      color: var(--error);
      font-size: 13px;
      line-height: 1.25;
      font-weight: 700;
    }
    .date-option input {
      width: 22px;
      height: 22px;
      margin: 0;
      accent-color: var(--accent);
    }
    .hint {
      margin: 8px 0 0;
      color: var(--ink-soft);
      font-size: 14px;
      line-height: 1.45;
    }
    .upload {
      position: relative;
      display: grid;
      place-items: center;
      min-height: 180px;
      padding: 22px;
      border: 1.5px dashed rgba(155, 46, 26, 0.36);
      border-radius: var(--radius-md);
      background: rgba(255, 252, 248, 0.68);
      cursor: pointer;
      text-align: center;
      transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease;
      overflow: hidden;
    }
    .upload::before {
      content: "";
      position: absolute;
      inset: 8px;
      border-radius: 16px;
      border: 1px solid rgba(18, 17, 14, 0.04);
      pointer-events: none;
    }
    .upload:hover {
      transform: translateY(-1px);
      border-color: rgba(155, 46, 26, 0.62);
      background: rgba(255, 252, 248, 0.94);
    }
    .upload input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }
    .plus {
      width: 52px;
      height: 52px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      margin: 0 auto 12px;
      background: linear-gradient(135deg, var(--accent), var(--accent-deep));
      color: #fff;
      font-size: 38px;
      line-height: 1;
      font-weight: 400;
      box-shadow: 0 14px 28px rgba(155, 46, 26, 0.24);
    }
    .upload strong {
      display: block;
      font-size: 16px;
      line-height: 1.3;
      color: var(--ink);
    }
    .file-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
      color: var(--ink-soft);
      font-size: 14px;
    }
    .file-chip {
      display: grid;
      gap: 8px;
      min-width: 0;
      padding: 8px;
      border: 1px solid rgba(18, 17, 14, 0.08);
      border-radius: var(--radius-sm);
      background: rgba(255, 252, 248, 0.82);
      overflow: hidden;
    }
    .file-chip img {
      width: 100%;
      aspect-ratio: 4 / 3;
      border-radius: 8px;
      object-fit: cover;
      background: rgba(18, 17, 14, 0.06);
    }
    .file-chip span {
      overflow-wrap: anywhere;
      color: var(--ink-soft);
      font-size: 12px;
      line-height: 1.25;
    }
    .consent {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 12px;
      align-items: start;
      padding: 14px;
      border: 1px solid rgba(18, 17, 14, 0.08);
      border-radius: var(--radius-sm);
      background: rgba(255, 252, 248, 0.56);
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
      min-height: 56px;
      border: 0;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-deep));
      color: #fff5ee;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 14px 28px rgba(155, 46, 26, 0.24);
      transition: transform 160ms ease, filter 160ms ease, opacity 160ms ease;
    }
    button:hover { transform: translateY(-1px); filter: brightness(1.02); }
    button:active { transform: translateY(1px); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.72;
      transform: none;
    }
    button[data-loading="true"] {
      cursor: wait;
    }
    .status {
      min-height: 24px;
      margin-top: -4px;
      font-size: 15px;
      line-height: 1.45;
    }
    .status[data-kind="success"] { color: var(--success); }
    .status[data-kind="error"] { color: var(--error); }
    .summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: -4px;
      padding: 14px;
      border: 1px solid rgba(18, 17, 14, 0.08);
      border-radius: var(--radius-sm);
      background: rgba(255, 252, 248, 0.86);
      font-size: 14px;
      line-height: 1.5;
    }
    .summary[hidden] {
      display: none;
    }
    .summary-item {
      min-width: 0;
      padding: 10px;
      border-radius: 10px;
      background: rgba(18, 17, 14, 0.035);
    }
    .summary-item span {
      display: block;
      color: var(--ink-muted);
      font-size: 12px;
      line-height: 1.25;
    }
    .summary-item strong {
      display: block;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .closed-panel {
      display: none;
      padding: 14px;
      border: 1px solid rgba(165, 47, 32, 0.18);
      border-radius: var(--radius-sm);
      background: rgba(165, 47, 32, 0.08);
      color: var(--error);
      font-size: 14px;
      line-height: 1.45;
      font-weight: 700;
    }
    .closed-panel.is-visible {
      display: block;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }
    @media (max-width: 980px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .event-meta {
        max-width: 680px;
      }
    }
    @media (max-width: 820px) {
      main { padding: 16px 14px 36px; }
      .topbar { margin-bottom: 18px; }
      .brand { width: 158px; }
      .preview-pill { min-height: 32px; padding: 0 10px; font-size: 12px; }
      .shell { gap: 18px; }
      .intro { gap: 18px; padding: 0; }
      h1 { font-size: 48px; }
      .lead { font-size: 16px; }
      .event-meta { grid-template-columns: 1fr; }
      .event-meta li { min-height: 84px; }
      .event-meta strong { font-size: 26px; }
      form { padding: 18px; border-radius: var(--radius-md); }
      .form-head h2 { font-size: 30px; }
      .summary { grid-template-columns: 1fr; }
    }
    @media (max-width: 420px) {
      h1 { font-size: 42px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .date-option { align-items: start; }
      .upload { min-height: 198px; padding: 18px; }
      .file-list { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="topbar">
      <span class="brand" aria-label="Знание. 80 лет Калининградской области">
        <img src="/shared-assets/logo-festival-single.svg" alt="" width="629" height="150" decoding="async">
      </span>
      <span class="preview-pill">Тестовая preview-ссылка</span>
    </div>
    <div class="shell">
      <section class="intro" aria-labelledby="page-title">
        <div>
          <p class="kicker">Заявка на розыгрыш</p>
          <h1 id="page-title">Этюды той весны</h1>
          <p class="lead">Иммерсивный спектакль. После проверки паспорта участника фестиваля заявка попадает в розыгрыш выбранных дат.</p>
        </div>
        <ul class="event-meta">
          <li><strong>11 июня</strong><span>18:00<br>Южный Вокзал</span></li>
          <li><strong>23 июня</strong><span>18:30<br>Южный Вокзал</span></li>
          <li><strong>25 июня</strong><span>18:30<br>Южный Вокзал</span></li>
        </ul>
        <p class="note-panel"><strong>Важно:</strong> заявка не является билетом и не гарантирует проход. Победители получат место на конкретный показ после розыгрыша.</p>
      </section>
      <form id="special-form" data-testid="special-form">
        <div class="form-head">
          <h2>Подать заявку</h2>
          <p>Выберите даты, на которые сможете прийти, и приложите фото паспорта участника с заполненным ФИО.</p>
        </div>
        <input type="hidden" name="website" autocomplete="off">
        <fieldset>
          <legend>Даты показа</legend>
          <p class="hint">Выберите самую раннюю дату, на которую хотите попасть: будущие показы отметятся автоматически. Если какая-то дополнительная дата вам не подходит, снимите галочку.</p>
          <div class="dates" id="dates"></div>
        </fieldset>
        <div class="closed-panel" id="closed-panel">Все даты уже закрыты для заявки.</div>
        <div class="fields">
          <label for="fullName">ФИО
            <input id="fullName" name="fullName" type="text" autocomplete="name" maxlength="120" placeholder="Имя и фамилия" required>
          </label>
          <label for="email">Email
            <input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com" required>
          </label>
          <label for="phone">Телефон
            <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" required>
          </label>
        </div>
        <fieldset>
          <span class="group-title">Паспорт участника фестиваля</span>
          <label class="upload" for="photos">
            <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple required data-testid="photo-input">
            <span>
              <span class="plus" aria-hidden="true">+</span>
              <strong>Приложите фотографию паспорта участника фестиваля</strong>
              <span class="hint">С заполненным полем ФИО. Если у вас несколько экземпляров, приложите несколько фотографий. Фотографии принимаются только с лицевой стороны.</span>
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
    const closedPanel = document.querySelector('#closed-panel');
    let previewUrls = [];

    function escapeHtml(value) {
      return String(value)
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
    }

    const firstAvailableIndex = SPECIAL_EVENT.showings.findIndex((showing) => showing.applicationAvailable);
    const hasAvailableShowings = firstAvailableIndex >= 0;
    dates.innerHTML = SPECIAL_EVENT.showings.map((showing, index) => {
      const disabled = !showing.applicationAvailable;
      const quotaText = \`Всего мест: \${showing.physicalQuota} · в розыгрыше: \${showing.lotteryQuota}\${showing.reservedSeats ? \` · бронь: \${showing.reservedSeats}\` : ''}\`;
      return \`
      <label class="date-option\${disabled ? ' is-disabled' : ''}">
        <input type="checkbox" name="selectedShowingSlugs" value="\${showing.slug}" data-showing-index="\${index}" \${disabled ? 'disabled' : ''}>
        <span class="date-option__main">
          <span>\${escapeHtml(showing.displayLabel)}</span>
          <span class="date-option__meta">\${escapeHtml(quotaText)}\${showing.timeIsFinal ? '' : ' · <span class="date-option__tag">время уточняется</span>'}</span>
          \${disabled ? \`<span class="date-option__closed">\${escapeHtml(showing.unavailableReason || 'Дата закрыта для заявки.')}</span>\` : ''}
        </span>
      </label>
    \`;
    }).join('');
    closedPanel.classList.toggle('is-visible', !hasAvailableShowings);
    if (!hasAvailableShowings) {
      submit.disabled = true;
      submit.textContent = 'Заявки закрыты';
      setStatus('error', 'Регистрация на все даты этого спецмероприятия закрыта.');
    } else {
      selectCascadeFrom(firstAvailableIndex);
    }

    dates.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.name !== 'selectedShowingSlugs' || !input.checked) {
        return;
      }

      selectCascadeFrom(Number(input.dataset.showingIndex || '0'));
    });

    function selectCascadeFrom(index) {
      const checkboxes = [...dates.querySelectorAll('input[name="selectedShowingSlugs"]')];
      checkboxes.forEach((checkbox, checkboxIndex) => {
        if (checkbox.disabled) {
          return;
        }

        checkbox.checked = checkboxIndex >= index;
      });
    }

    photosInput.addEventListener('change', () => {
      const files = [...photosInput.files];
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls = files.map((file) => URL.createObjectURL(file));
      fileList.innerHTML = files.length
        ? files.map((file, index) => \`<span class="file-chip"><img src="\${previewUrls[index]}" alt=""><span>\${escapeHtml(file.name)}</span></span>\`).join('')
        : '';
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
      submit.dataset.loading = 'true';
      submit.textContent = 'Проверяем фото...';

      try {
        const formData = new FormData(form);
        const selectedShowingSlugs = formData.getAll('selectedShowingSlugs');
        if (!selectedShowingSlugs.length) {
          throw new Error('Выберите хотя бы одну доступную дату показа.');
        }
        const files = [...photosInput.files];
        const photos = await Promise.all(files.map(async (file) => ({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          dataBase64: await fileToBase64(file),
        })));
        const payload = {
          token: TOKEN,
          eventSlug: SPECIAL_EVENT.slug,
          selectedShowingSlugs,
          fullName: String(formData.get('fullName') || ''),
          email: String(formData.get('email') || ''),
          phone: String(formData.get('phone') || ''),
          consentAccepted: formData.get('consentAccepted') === 'on',
          website: String(formData.get('website') || ''),
          vkAuthToken: String(formData.get('vkAuthToken') || ''),
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
          \`<div class="summary-item"><span>Код заявки</span><strong>\${data.applicationCode}</strong></div>\`,
          \`<div class="summary-item"><span>Штампы</span><strong>\${data.scoring.stampCount}</strong></div>\`,
          \`<div class="summary-item"><span>Баллы</span><strong>\${data.scoring.score}</strong></div>\`,
          \`<div class="summary-item"><span>Выбрано дат</span><strong>\${data.selectedShowings.length}</strong></div>\`,
          data.scoring.volunteerBonusPoints > 0
            ? \`<div class="summary-item"><span>Волонтерский бонус</span><strong>+10 баллов — добро! Спасибо за помощь фестивалю.</strong></div>\`
            : '',
        ].join('');
      } catch (error) {
        setStatus('error', error instanceof Error ? error.message : 'Не удалось отправить заявку.');
      } finally {
        submit.dataset.loading = 'false';
        if (hasAvailableShowings) {
          submit.disabled = false;
          submit.textContent = 'Отправить заявку';
        } else {
          submit.disabled = true;
          submit.textContent = 'Заявки закрыты';
        }
      }
    });
  </script>
</body>
</html>`;
}

export async function registerSpecialApi(app: FastifyInstance, deps: SpecialApiDeps) {
  if (!app.hasContentTypeParser(/^multipart\/form-data/u)) {
    app.addContentTypeParser(/^multipart\/form-data/u, {
      parseAs: 'buffer',
      bodyLimit: SPECIAL_BODY_LIMIT_BYTES,
    }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get(PREVIEW_PATH, async (_request, reply) => {
    const event = getSpecialEventPreview(deps.db, PREVIEW_SLUG, PREVIEW_TOKEN);
    if (!event) {
      reply.code(404);
      return 'Preview not found';
    }

    noIndex(reply);
    return reply.redirect(PREVIEW_PUBLIC_URL, 302);
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
    bodyLimit: SPECIAL_BODY_LIMIT_BYTES,
    config: {
      rateLimit: {
        max: 3,
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

  app.post('/api/v1/special/applications-multipart', {
    bodyLimit: SPECIAL_BODY_LIMIT_BYTES,
    config: {
      rateLimit: {
        max: 3,
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
      const contentType = String(request.headers['content-type'] || '');
      const rawBody = request.body as Buffer;
      const parts = parseMultipartBody(contentType, rawBody);
      request.log.info({
        route: 'applications-multipart',
        contentType,
        bodyBytes: rawBody.length,
        partCount: parts.length,
        parts: multipartPartLogSummary(parts),
      }, 'special_application_multipart_received');
      const payload = multipartApplicationPayloadFromParts(parts);
      request.log.info({
        route: 'applications-multipart',
        selectedShowingCount: payload.selectedShowingSlugs.length,
        photoCount: payload.photos.length,
        photos: photoPayloadLogSummary(payload.photos),
      }, 'special_application_multipart_parsed');
      const created = await createSpecialApplication(payload, {
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
      request.log.info({
        route: 'applications-multipart',
        status: created.status,
        selectedShowingCount: created.selectedShowings.length,
        stampCount: created.scoring.stampCount,
        score: created.scoring.score,
      }, 'special_application_multipart_created');
      return created;
    } catch (error) {
      if (error instanceof SpecialApplicationError) {
        request.log.warn({
          route: 'applications-multipart',
          code: error.code,
          statusCode: error.statusCode,
          contentType: String(request.headers['content-type'] || ''),
          bodyBytes: Buffer.isBuffer(request.body) ? request.body.length : null,
        }, 'special_application_multipart_rejected');
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error }, 'special_application_multipart_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось отправить заявку. Попробуйте ещё раз чуть позже.',
      };
    }
  });

  app.post('/api/v1/special/photo-check', {
    bodyLimit: SPECIAL_BODY_LIMIT_BYTES,
    config: {
      rateLimit: {
        max: 6,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    noIndex(reply);

    try {
      const payload = request.body as SpecialPhotoCheckPayload;
      request.log.info({
        route: 'photo-check',
        photoCount: payload.photos?.length || 0,
        photos: photoPayloadLogSummary(payload.photos || []),
      }, 'special_photo_check_received');
      const result = await checkSpecialApplicationPhotos(payload, {
        db: deps.db,
        fingerprintSecret: deps.fingerprintSecret,
        privateKeyPemBase64: deps.privateKeyPemBase64,
      });
      request.log.info({
        route: 'photo-check',
        photoCount: result.photos.length,
        acceptedPhotoCount: result.scoring.acceptedPhotoCount,
        stampCount: result.scoring.stampCount,
        score: result.scoring.score,
      }, 'special_photo_check_completed');
      return result;
    } catch (error) {
      if (error instanceof SpecialApplicationError) {
        request.log.warn({
          route: 'photo-check',
          code: error.code,
          statusCode: error.statusCode,
        }, 'special_photo_check_rejected');
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error }, 'special_photo_check_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось проверить фотографии. Попробуйте ещё раз чуть позже.',
      };
    }
  });

  app.post('/api/v1/special/photo-check-multipart', {
    bodyLimit: SPECIAL_BODY_LIMIT_BYTES,
    config: {
      rateLimit: {
        max: 6,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    noIndex(reply);

    try {
      const contentType = String(request.headers['content-type'] || '');
      const rawBody = request.body as Buffer;
      const parts = parseMultipartBody(contentType, rawBody);
      request.log.info({
        route: 'photo-check-multipart',
        contentType,
        bodyBytes: rawBody.length,
        partCount: parts.length,
        parts: multipartPartLogSummary(parts),
      }, 'special_photo_check_multipart_received');
      const payload = multipartPhotoCheckPayloadFromParts(parts);
      request.log.info({
        route: 'photo-check-multipart',
        photoCount: payload.photos.length,
        photos: photoPayloadLogSummary(payload.photos),
      }, 'special_photo_check_multipart_parsed');
      const result = await checkSpecialApplicationPhotos(payload, {
        db: deps.db,
        fingerprintSecret: deps.fingerprintSecret,
        privateKeyPemBase64: deps.privateKeyPemBase64,
        returnPhotoDataBase64: true,
      });
      request.log.info({
        route: 'photo-check-multipart',
        photoCount: result.photos.length,
        acceptedPhotoCount: result.scoring.acceptedPhotoCount,
        stampCount: result.scoring.stampCount,
        score: result.scoring.score,
      }, 'special_photo_check_multipart_completed');
      return result;
    } catch (error) {
      if (error instanceof SpecialApplicationError) {
        request.log.warn({
          route: 'photo-check-multipart',
          code: error.code,
          statusCode: error.statusCode,
          contentType: String(request.headers['content-type'] || ''),
          bodyBytes: Buffer.isBuffer(request.body) ? request.body.length : null,
        }, 'special_photo_check_multipart_rejected');
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error }, 'special_photo_check_multipart_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось проверить фотографии. Попробуйте ещё раз чуть позже.',
      };
    }
  });
}

export { PREVIEW_PATH as SPECIAL_PREVIEW_PATH };
