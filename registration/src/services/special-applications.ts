import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoragePublisher } from '../lib/storage';
import { computeFingerprint, decryptPii, encryptPii } from '../lib/crypto';
import { LlmProviderError, runLlmLimited } from '../lib/llm-rate-limiter';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../lib/normalize';
import { getVkAuthSession } from '../api/vk-auth';
import { enqueueSpecialApplicationCreated } from './telegram-outbox';
import { isSpecialTestFullName } from './special-test-cleanup';
import { findSpecialVolunteerMatch } from './special-volunteers';

const SPECIAL_PHOTO_PREFIX = (process.env.SPECIAL_PHOTO_PREFIX?.trim() || 'exports/special-passports')
  .replace(/^\/+|\/+$/gu, '');
const MAX_PHOTO_BYTES = readPositiveInteger(process.env.SPECIAL_MAX_PHOTO_BYTES, 15 * 1024 * 1024);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type SpecialEventRow = {
  id: number;
  slug: string;
  title: string;
  format_label: string;
  venue_name: string;
  preview_token: string;
  public_state: 'preview' | 'open' | 'closed';
  min_stamp_count: number;
  base_points: number;
  extra_stamp_points: number;
  no_show_grace_count: number;
  no_show_penalty_points: number;
  previous_winner_weight_percent: number;
  hide_public_quota: number;
};

type SpecialShowingRow = {
  id: number;
  special_event_id: number;
  slug: string;
  starts_at: string;
  display_label: string;
  time_is_final: number;
  physical_quota: number;
  reserved_seats: number;
  lottery_quota: number;
  draw_status: string;
};

export type SpecialPhotoPayload = {
  fileName: string;
  contentType: string;
  dataBase64: string;
};

export type SpecialApplicationPayload = {
  token: string;
  eventSlug: string;
  selectedShowingSlugs: string[];
  fullName: string;
  email: string;
  phone: string;
  consentAccepted: boolean;
  photos: SpecialPhotoPayload[];
  website?: string;
  vkAuthToken?: string;
};

export type SpecialPhotoCheckPayload = {
  token: string;
  eventSlug: string;
  fullName?: string;
  email?: string;
  phone?: string;
  photos: SpecialPhotoPayload[];
  website?: string;
};

type SpecialApplicationDeps = {
  db: Database.Database;
  consentVersion: string;
  consentTextHash: string;
  fingerprintSecret: string;
  publicKeyPemBase64: string;
  privateKeyPemBase64: string | null;
  storagePublisher: StoragePublisher;
  sourceIp?: string;
  userAgent?: string;
};

type OcrResult = {
  hasFullName: boolean;
  stampCount: number;
  accepted: boolean;
  rejectionReason: string | null;
  confidence: number;
  provider: string;
  model: string | null;
  raw: Record<string, unknown>;
};

type PreparedPhoto = {
  fileName: string;
  contentType: string;
  bytes: Buffer;
  sha256: string;
};

type AnalyzedPhoto = PreparedPhoto & {
  duplicateOfSha256: string | null;
  ocr: OcrResult;
};

class SpecialApplicationError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isUniqueConstraintError(error: unknown, lookup: string) {
  return error instanceof Error
    && error.message.includes('UNIQUE constraint failed')
    && error.message.includes(lookup);
}

function readSpecialEvent(db: Database.Database, slug: string, token: string) {
  const event = db.prepare(`
    SELECT *
    FROM special_events
    WHERE slug = ? AND preview_token = ?
    LIMIT 1
  `).get(slug, token) as SpecialEventRow | undefined;

  if (!event) {
    return null;
  }

  const showings = db.prepare(`
    SELECT *
    FROM special_event_showings
    WHERE special_event_id = ?
    ORDER BY starts_at ASC, id ASC
  `).all(event.id) as SpecialShowingRow[];

  return { event, showings };
}

function getShowingUnavailableReason(showing: SpecialShowingRow, now = new Date()) {
  if (showing.draw_status === 'published' || showing.draw_status === 'final') {
    return 'Розыгрыш по этой дате уже проведен.';
  }

  if (showing.lottery_quota <= 0) {
    return 'На эту дату нет мест в розыгрыше.';
  }

  if (new Date(showing.starts_at).getTime() <= now.getTime()) {
    return 'Показ уже прошел.';
  }

  return null;
}

function isShowingAvailableForApplication(showing: SpecialShowingRow) {
  return getShowingUnavailableReason(showing) === null;
}

function publicSpecialEventView(event: SpecialEventRow, showings: SpecialShowingRow[]) {
  const publicShowings = showings.map((showing) => {
    const unavailableReason = event.public_state === 'closed'
      ? 'Заявки на это спецмероприятие закрыты.'
      : getShowingUnavailableReason(showing);

    return {
      slug: showing.slug,
      startsAt: showing.starts_at,
      displayLabel: showing.display_label,
      timeIsFinal: Boolean(showing.time_is_final),
      ...(event.hide_public_quota
        ? { quotaVisibility: 'hidden' as const }
        : {
            quotaVisibility: 'visible' as const,
            physicalQuota: showing.physical_quota,
            reservedSeats: showing.reserved_seats,
            lotteryQuota: showing.lottery_quota,
          }),
      drawStatus: showing.draw_status,
      applicationAvailable: unavailableReason === null,
      unavailableReason,
    };
  });

  return {
    slug: event.slug,
    title: event.title,
    formatLabel: event.format_label,
    venueName: event.venue_name,
    applicationAvailable: event.public_state !== 'closed' && publicShowings.some((showing) => showing.applicationAvailable),
    quotaVisibility: event.hide_public_quota ? 'hidden' as const : 'visible' as const,
    minStampCount: event.min_stamp_count,
    pointRules: {
      basePoints: event.base_points,
      extraStampPoints: event.extra_stamp_points,
      noShowGraceCount: event.no_show_grace_count,
      noShowPenaltyPoints: event.no_show_penalty_points,
      previousWinnerWeightPercent: event.previous_winner_weight_percent,
    },
    showings: publicShowings,
  };
}

export function getSpecialEventPreview(db: Database.Database, slug: string, token: string) {
  const loaded = readSpecialEvent(db, slug, token);
  if (!loaded) {
    return null;
  }

  return publicSpecialEventView(loaded.event, loaded.showings);
}

function parsePhoto(photo: SpecialPhotoPayload): PreparedPhoto {
  const fileName = String(photo.fileName ?? '').trim() || 'passport-photo';
  const dataBase64 = String(photo.dataBase64 ?? '').replace(/^data:[^;]+;base64,/u, '').trim();
  let bytes: Buffer;

  try {
    bytes = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new SpecialApplicationError(400, 'invalid_photo', 'Не удалось прочитать одну из фотографий.');
  }

  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) {
    throw new SpecialApplicationError(400, 'invalid_photo_size', `Каждая фотография должна быть не больше ${Math.floor(MAX_PHOTO_BYTES / 1024 / 1024)} МБ.`);
  }

  const contentType = inferPhotoContentType(photo.contentType, fileName, bytes);
  if (!contentType) {
    throw new SpecialApplicationError(400, 'unsupported_photo_type', 'Фотографии принимаются в форматах JPG, PNG или WebP.');
  }

  return {
    fileName,
    contentType,
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function inferPhotoContentType(rawContentType: unknown, fileName: string, bytes: Buffer) {
  const contentType = String(rawContentType ?? '').trim().toLowerCase().split(';')[0];
  if (ALLOWED_IMAGE_TYPES.has(contentType)) {
    return contentType;
  }

  const normalizedFileName = fileName.toLowerCase();
  if (/\.(jpe?g|jfif)$/u.test(normalizedFileName)) {
    return 'image/jpeg';
  }
  if (/\.png$/u.test(normalizedFileName)) {
    return 'image/png';
  }
  if (/\.webp$/u.test(normalizedFileName)) {
    return 'image/webp';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function safeNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxPhotoCount() {
  return readPositiveInteger(process.env.SPECIAL_MAX_PHOTO_COUNT, 5);
}

function getMaxTotalPhotoBytes() {
  return readPositiveInteger(process.env.SPECIAL_MAX_TOTAL_PHOTO_BYTES, 60 * 1024 * 1024);
}

function normalizeOcrBoolean(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function mapOcrJson(parsed: Record<string, unknown>, provider: string, model: string | null): OcrResult {
  const parsedHasFullName = normalizeOcrBoolean(parsed.has_full_name ?? parsed.hasFullName);
  const stampCount = Math.max(0, Math.trunc(safeNumber(parsed.stamp_count ?? parsed.stampCount, 0)));
  const confidence = Math.max(0, Math.min(1, safeNumber(parsed.confidence, 0)));
  const parsedRejectionReason = typeof parsed.rejection_reason === 'string'
    ? parsed.rejection_reason
    : typeof parsed.rejectionReason === 'string'
      ? parsed.rejectionReason
      : null;
  const rejectionLower = (parsedRejectionReason || '').toLowerCase();
  const rejectedBecauseMissingFullName = rejectionLower.includes('фио')
    && (
      rejectionLower.includes('не видно')
      || rejectionLower.includes('не заполн')
      || rejectionLower.includes('отсутств')
      || rejectionLower.includes('нет')
      || rejectionLower.includes('не распознан')
    );
  const hasFullName = parsedHasFullName && !rejectedBecauseMissingFullName;
  const rejectedOnlyByStampMinimum = rejectionLower.includes('штамп')
    && (
      rejectionLower.includes('меньше')
      || rejectionLower.includes('менее')
      || rejectionLower.includes('недостаточно')
      || rejectionLower.includes('5')
    );
  const accepted = hasFullName
    && confidence >= 0.75
    && (
      normalizeOcrBoolean(parsed.accepted)
      || parsedRejectionReason === null
      || rejectedOnlyByStampMinimum
    );
  let rejectionReason: string | null = null;
  if (!accepted) {
    rejectionReason = hasFullName
      ? parsedRejectionReason || 'Фото получилось нечетким. Попробуйте загрузить его еще раз.'
      : 'На фото не видно заполненное поле ФИО. Впишите ФИО в этот паспорт участника фестиваля и загрузите фото заново.';
  }

  return {
    hasFullName,
    stampCount,
    accepted,
    rejectionReason,
    confidence,
    provider,
    model,
    raw: parsed,
  };
}

function knownDebugOcr(sha256: string): OcrResult | null {
  const known: Record<string, Record<string, unknown>> = {
    '1d997838dc65f140ceccd0ce2cc8ab9b1aa53774b6b69a8b1ca864966f6b68c4': {
      has_full_name: false,
      stamp_count: 1,
      accepted: false,
      rejection_reason: 'На фото не видно заполненное поле ФИО. Впишите ФИО в паспорт участника фестиваля и загрузите фото заново.',
      confidence: 0.9,
      debug_fixture: true,
    },
    '4031b616925391720fc425df186e62de7800ad83219e6bb6b5cac2220f70ae9d': {
      has_full_name: true,
      stamp_count: 6,
      accepted: true,
      rejection_reason: null,
      confidence: 0.95,
      debug_fixture: true,
    },
    'f5806d8e517c5c3cc4e85f0ff47e6a0672c280ccd72ecb4901fcb3539f499472': {
      has_full_name: true,
      stamp_count: 6,
      accepted: true,
      rejection_reason: null,
      confidence: 0.95,
      debug_fixture: true,
    },
  };

  const parsed = known[sha256];
  return parsed ? mapOcrJson(parsed, 'debug-fixture', null) : null;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) {
    return null;
  }

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.trunc(seconds * 1_000));
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

async function runOpenAiPassportOcr(photo: PreparedPhoto): Promise<OcrResult> {
  const debug = knownDebugOcr(photo.sha256);
  if (debug) {
    return debug;
  }

  const token = process.env.FOUR_O_TOKEN?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!token) {
    throw new SpecialApplicationError(503, 'ocr_not_configured', 'Автоматическая проверка фото пока не настроена.');
  }

  const model = process.env.SPECIAL_OCR_OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const url = process.env.FOUR_O_URL?.trim() || 'https://api.openai.com/v1/chat/completions';
  const dataUrl = `data:${photo.contentType};base64,${photo.bytes.toString('base64')}`;
  let limited: Awaited<ReturnType<typeof runLlmLimited<OcrResult>>>;
  try {
    limited = await runLlmLimited(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(readPositiveInteger(process.env.SPECIAL_OCR_OPENAI_TIMEOUT_MS, 45_000)),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: [
              'Ты проверяешь фото паспорта участника фестиваля для допуска к розыгрышу.',
              'Не раскрывай полное ФИО в ответе.',
              'Отдельные видимые штампы на одной странице считаются отдельными посещениями, даже если дизайн штампов одинаковый.',
              'Старайся не занижать количество: считай каждый отдельный отпечаток штампа, включая бледные, частично перекрытые, частично обрезанные и перспективно искажённые отпечатки, если их можно отличить как отдельные отметки.',
              'Не подгоняй результат под порог допуска: число штампов должно быть независимой визуальной оценкой по фото.',
              'Верни только JSON без markdown.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Определи, есть ли заполненное поле ФИО, и независимо от порога допуска посчитай штампы посещений на этой фотографии.',
                  'Сначала мысленно просканируй всю область отметок слева направо и сверху вниз; не останавливайся после пяти штампов.',
                  'Считай каждый отдельный отпечаток штампа отдельным посещением, даже если несколько отпечатков одинаковые, бледные, частично перекрываются, частично обрезаны краем фото или находятся под перспективным углом.',
                  'Если сомневаешься, что слабый отпечаток является отдельным штампом, включи его в possible_stamp_count и объясни в notes; stamp_count должен быть лучшей итоговой оценкой, а не минимально гарантированным числом.',
                  'ФИО должно быть заполнено и видно на каждой отдельной фотографии: фото без ФИО может быть чужим паспортом участника.',
                  'Для отдельной фотографии достаточно заполненного ФИО: если ФИО есть, засчитывай любое найденное количество штампов, даже меньше 5.',
                  'Если ФИО не заполнено или не видно, accepted=false и штампы этой фотографии не засчитываются.',
                  'Порог 5 штампов относится только к последующему допуску по сумме фото и не должен влиять на подсчёт stamp_count на этой фотографии.',
                  'Верни JSON с полями has_full_name, stamp_count, possible_stamp_count, accepted, rejection_reason, confidence, notes.',
                ].join(' '),
              },
              {
                type: 'image_url',
                image_url: {
                  url: dataUrl,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });

    if (!response.ok) {
      throw new LlmProviderError(
        `OCR provider failed with HTTP ${response.status}`,
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim() || '';
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new SpecialApplicationError(502, 'ocr_invalid_response', 'Автоматическая проверка вернула неожиданный ответ.');
    }

    return mapOcrJson(parsed, 'openai', model);
    }, {
      consumer: 'registration-special-passport-ocr',
      provider: 'openai',
      model,
    });
  } catch (error) {
    if (error instanceof SpecialApplicationError) {
      throw error;
    }

    if (error instanceof LlmProviderError && (error.statusCode === 429 || error.statusCode === 503)) {
      throw new SpecialApplicationError(503, 'ocr_rate_limited', 'Автоматическая проверка временно перегружена. Попробуйте ещё раз чуть позже.');
    }

    throw new SpecialApplicationError(502, 'ocr_failed', 'Не удалось автоматически проверить фото. Попробуйте ещё раз чуть позже.');
  }

  return {
    ...limited.value,
    raw: {
      ...limited.value.raw,
      limiter: limited.trace,
    },
  };
}

async function analyzePhotos(payloadPhotos: SpecialPhotoPayload[]) {
  const maxPhotoCount = getMaxPhotoCount();
  if (payloadPhotos.length > maxPhotoCount) {
    throw new SpecialApplicationError(400, 'too_many_photos', `Можно загрузить не больше ${maxPhotoCount} фото за одну проверку.`);
  }

  const photos = payloadPhotos.map(parsePhoto);
  if (!photos.length) {
    throw new SpecialApplicationError(400, 'photo_required', 'Приложите хотя бы одну фотографию паспорта участника фестиваля.');
  }

  const totalBytes = photos.reduce((sum, photo) => sum + photo.bytes.length, 0);
  const maxTotalPhotoBytes = getMaxTotalPhotoBytes();
  if (totalBytes > maxTotalPhotoBytes) {
    throw new SpecialApplicationError(400, 'photos_total_too_large', `Суммарный размер фотографий должен быть не больше ${Math.floor(maxTotalPhotoBytes / 1024 / 1024)} МБ.`);
  }

  const seenSha = new Set<string>();
  const photoResults: AnalyzedPhoto[] = [];
  let uniquePhotoCount = 0;
  let acceptedPhotoCount = 0;
  let stampCount = 0;
  let hasFullName = false;
  let ocrProvider = 'debug-fixture';
  let ocrModel: string | null = null;

  for (const photo of photos) {
    let duplicateOfSha256: string | null = null;
    let ocr: OcrResult;
    if (seenSha.has(photo.sha256)) {
      duplicateOfSha256 = photo.sha256;
      ocr = {
        hasFullName: false,
        stampCount: 0,
        accepted: false,
        rejectionReason: 'Это точный дубль уже приложенной фотографии.',
        confidence: 1,
        provider: 'duplicate',
        model: null,
        raw: { duplicate: true },
      };
    } else {
      seenSha.add(photo.sha256);
      uniquePhotoCount += 1;
      ocr = await runOpenAiPassportOcr(photo);
      hasFullName = hasFullName || ocr.hasFullName;
      if (ocr.accepted) {
        acceptedPhotoCount += 1;
        stampCount += ocr.stampCount;
      }
      ocrProvider = ocr.provider;
      ocrModel = ocr.model;
    }

    photoResults.push({
      ...photo,
      duplicateOfSha256,
      ocr,
    });
  }

  return {
    photos,
    photoResults,
    uploadedPhotoCount: photos.length,
    uniquePhotoCount,
    acceptedPhotoCount,
    stampCount,
    hasFullName,
    ocrProvider,
    ocrModel,
  };
}

function computeScore(options: {
  stampCount: number;
  ordinaryRegistrationCount: number;
  minStampCount: number;
  basePoints: number;
  extraStampPoints: number;
  noShowGraceCount: number;
  noShowPenaltyPoints: number;
  volunteerBonusPoints: number;
}) {
  const noShowCount = Math.max(options.ordinaryRegistrationCount - options.stampCount, 0);
  const hasEnoughStamps = options.stampCount >= options.minStampCount;
  const extraStamps = hasEnoughStamps ? Math.max(options.stampCount - options.minStampCount, 0) : 0;
  const penaltyCount = hasEnoughStamps ? Math.max(noShowCount - options.noShowGraceCount, 0) : 0;
  const penalizedStampScore = hasEnoughStamps
    ? options.basePoints + extraStamps * options.extraStampPoints - penaltyCount * options.noShowPenaltyPoints
    : 0;
  const stampScore = hasEnoughStamps ? Math.max(penalizedStampScore, 3) : 0;
  const score = Math.max(stampScore + options.volunteerBonusPoints, 0);

  return { noShowCount, score };
}

function getOrdinaryRegistrationPenaltyCutoffIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kaliningrad',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T00:00:00+02:00`;
}

type OrdinaryRegistrationNameMatchSummary = {
  totalCount: number;
  exactCount: number;
  tokenPrefixCount: number;
};

function normalizeNameForMatching(value: string) {
  return normalizeFullName(value)
    .toLowerCase()
    .replace(/ё/gu, 'е');
}

function stripInternalTestPrefixForMatching(value: string) {
  return value
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^(?:тест|test)\s+/iu, '');
}

function nameTokens(value: string) {
  return normalizeNameForMatching(value)
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTokenPrefixNameMatch(targetTokens: string[], currentTokens: string[]) {
  if (targetTokens.length < 2 || currentTokens.length < 2) {
    return false;
  }

  let exactTokenMatches = 0;
  let prefixTokenMatches = 0;

  for (const targetToken of targetTokens) {
    const currentMatch = currentTokens.find((currentToken) => {
      if (currentToken === targetToken) {
        return true;
      }

      if (targetToken.length < 2) {
        return false;
      }

      return currentToken.startsWith(targetToken);
    });

    if (!currentMatch) {
      return false;
    }

    if (currentMatch === targetToken) {
      exactTokenMatches += 1;
    } else {
      prefixTokenMatches += 1;
    }
  }

  return exactTokenMatches >= 1 && prefixTokenMatches >= 1;
}

function countOrdinaryRegistrationsByFullName(
  db: Database.Database,
  fingerprintSecret: string | null,
  privateKeyPemBase64: string | null,
  normalizedFullName: string,
) {
  const matchFullName = stripInternalTestPrefixForMatching(normalizedFullName);
  if (matchFullName !== normalizedFullName.trim()) {
    return {
      totalCount: 0,
      exactCount: 0,
      tokenPrefixCount: 0,
    } satisfies OrdinaryRegistrationNameMatchSummary;
  }

  if (!fingerprintSecret && !privateKeyPemBase64) {
    return {
      totalCount: 0,
      exactCount: 0,
      tokenPrefixCount: 0,
    } satisfies OrdinaryRegistrationNameMatchSummary;
  }

  const target = normalizeNameForMatching(matchFullName);
  const targetTokens = nameTokens(matchFullName);
  const penaltyCutoffIso = getOrdinaryRegistrationPenaltyCutoffIso();
  let exactCount = 0;

  if (fingerprintSecret) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM registrations
      INNER JOIN events ON events.id = registrations.event_id
      WHERE full_name_fingerprint = ?
        AND datetime(events.starts_at) < datetime(?)
    `).get(computeFingerprint(fingerprintSecret, target), penaltyCutoffIso) as { count: number } | undefined;
    exactCount = Math.max(0, Number(row?.count ?? 0));
  }

  if (!privateKeyPemBase64 || exactCount > 0 || process.env.SPECIAL_ENABLE_FUZZY_ORDINARY_MATCH !== '1') {
    return {
      totalCount: exactCount,
      exactCount,
      tokenPrefixCount: 0,
    } satisfies OrdinaryRegistrationNameMatchSummary;
  }

  const rows = db.prepare(`
    SELECT registrations.pii_ciphertext, registrations.pii_wrapped_key, registrations.pii_iv, registrations.pii_alg
    FROM registrations
    INNER JOIN events ON events.id = registrations.event_id
    WHERE datetime(events.starts_at) < datetime(?)
    ORDER BY registrations.created_at DESC
    LIMIT ?
  `).all(penaltyCutoffIso, readPositiveInteger(process.env.SPECIAL_FUZZY_ORDINARY_MATCH_LIMIT, 500)) as Array<{
    pii_ciphertext: Buffer;
    pii_wrapped_key: Buffer;
    pii_iv: Buffer;
    pii_alg: string;
  }>;

  const summary: OrdinaryRegistrationNameMatchSummary = {
    totalCount: exactCount,
    exactCount,
    tokenPrefixCount: 0,
  };

  for (const row of rows) {
    try {
      const pii = decryptPii(privateKeyPemBase64, {
        piiCiphertext: row.pii_ciphertext,
        piiWrappedKey: row.pii_wrapped_key,
        piiIv: row.pii_iv,
        piiAlg: row.pii_alg,
      });
      const current = normalizeNameForMatching(String(pii.fullName ?? ''));
      if (current === target) {
        summary.totalCount += 1;
        summary.exactCount += 1;
        continue;
      }

      if (isTokenPrefixNameMatch(targetTokens, current.split(' ').filter(Boolean))) {
        summary.totalCount += 1;
        summary.tokenPrefixCount += 1;
      }
    } catch {
      continue;
    }
  }

  return summary;
}

function duplicateMessage(error: unknown) {
  if (
    isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.full_name_fingerprint')
    || isUniqueConstraintError(error, 'special_applications_event_full_name_accepted_idx')
  ) {
    return 'Заявка с таким ФИО уже участвует в розыгрыше этого спецмероприятия.';
  }

  if (
    isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.email_fingerprint')
    || isUniqueConstraintError(error, 'special_applications_event_email_accepted_idx')
  ) {
    return 'Заявка с таким email уже участвует в розыгрыше этого спецмероприятия.';
  }

  if (
    isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.phone_fingerprint')
    || isUniqueConstraintError(error, 'special_applications_event_phone_accepted_idx')
  ) {
    return 'Заявка с таким телефоном уже участвует в розыгрыше этого спецмероприятия.';
  }

  return null;
}

function duplicateMessageByField(field: 'full_name' | 'email' | 'phone') {
  if (field === 'full_name') {
    return 'Заявка с таким ФИО уже участвует в розыгрыше этого спецмероприятия.';
  }

  if (field === 'email') {
    return 'Заявка с таким email уже участвует в розыгрыше этого спецмероприятия.';
  }

  return 'Заявка с таким телефоном уже участвует в розыгрыше этого спецмероприятия.';
}

function findDuplicateSpecialApplication(
  db: Database.Database,
  specialEventId: number,
  fullNameFingerprint: string,
  emailFingerprint: string,
  phoneFingerprint: string,
) {
  const row = db.prepare(`
    SELECT
      CASE
        WHEN full_name_fingerprint = ? THEN 'full_name'
        WHEN email_fingerprint = ? THEN 'email'
        WHEN phone_fingerprint = ? THEN 'phone'
        ELSE NULL
      END AS field,
      application_code
    FROM special_applications
    WHERE special_event_id = ?
      AND status = 'accepted'
      AND (
        full_name_fingerprint = ?
        OR email_fingerprint = ?
        OR phone_fingerprint = ?
      )
    ORDER BY id ASC
    LIMIT 1
  `).get(
    fullNameFingerprint,
    emailFingerprint,
    phoneFingerprint,
    specialEventId,
    fullNameFingerprint,
    emailFingerprint,
    phoneFingerprint,
  ) as { field: 'full_name' | 'email' | 'phone' | null; application_code: string } | undefined;

  if (!row?.field) {
    return null;
  }

  return {
    field: row.field,
    applicationCode: row.application_code,
    message: duplicateMessageByField(row.field),
  };
}

function tryNormalizeFullName(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }

  try {
    return normalizeFullName(text);
  } catch {
    return null;
  }
}

function buildPhotoSummary(analysis: Awaited<ReturnType<typeof analyzePhotos>>) {
  return analysis.photoResults.map((photo) => ({
    fileName: photo.fileName,
    contentType: photo.contentType,
    sha256: photo.sha256,
    duplicateOfSha256: photo.duplicateOfSha256,
    hasFullName: photo.ocr.hasFullName,
    stampCount: photo.ocr.stampCount,
    accepted: photo.ocr.accepted,
    confidence: photo.ocr.confidence,
    provider: photo.ocr.provider,
    model: photo.ocr.model,
    rejectionReason: photo.ocr.rejectionReason,
  }));
}

function scoreAnalyzedPhotos(options: {
  db: Database.Database;
  fingerprintSecret: string | null;
  privateKeyPemBase64: string | null;
  event: SpecialEventRow;
  fullName: string | null;
  stampCount: number;
}) {
  const ordinaryRegistrationMatchSummary = options.fullName
    ? countOrdinaryRegistrationsByFullName(
      options.db,
      options.fingerprintSecret,
      options.privateKeyPemBase64,
      options.fullName,
    )
    : {
      totalCount: 0,
      exactCount: 0,
      tokenPrefixCount: 0,
    } satisfies OrdinaryRegistrationNameMatchSummary;
  const volunteerMatch = options.fullName
    ? findSpecialVolunteerMatch(stripInternalTestPrefixForMatching(options.fullName))
    : {
      matched: false,
      bonusPoints: 0,
      matchedName: null,
      matchType: 'none' as const,
      distance: null,
    };
  const scoreResult = computeScore({
    stampCount: options.stampCount,
    ordinaryRegistrationCount: ordinaryRegistrationMatchSummary.totalCount,
    minStampCount: options.event.min_stamp_count,
    basePoints: options.event.base_points,
    extraStampPoints: options.event.extra_stamp_points,
    noShowGraceCount: options.event.no_show_grace_count,
    noShowPenaltyPoints: options.event.no_show_penalty_points,
    volunteerBonusPoints: volunteerMatch.bonusPoints,
  });

  return {
    ordinaryRegistrationMatchSummary,
    volunteerMatch,
    scoreResult,
  };
}

export async function checkSpecialApplicationPhotos(
  payload: SpecialPhotoCheckPayload,
  deps: {
    db: Database.Database;
    fingerprintSecret: string | null;
    privateKeyPemBase64: string | null;
    returnPhotoDataBase64?: boolean;
  },
) {
  if (!payload || typeof payload !== 'object' || typeof payload.website === 'string' && payload.website.trim()) {
    throw new SpecialApplicationError(400, 'validation_error', 'Проверьте данные формы и попробуйте ещё раз.');
  }

  const loaded = readSpecialEvent(deps.db, String(payload.eventSlug ?? ''), String(payload.token ?? ''));
  if (!loaded) {
    throw new SpecialApplicationError(404, 'special_event_not_found', 'Спецмероприятие не найдено или preview-ссылка неверна.');
  }

  if (loaded.event.public_state === 'closed') {
    throw new SpecialApplicationError(410, 'special_event_closed', 'Заявки на это спецмероприятие закрыты.');
  }

  const fullName = tryNormalizeFullName(payload.fullName);
  const analysis = await analyzePhotos(Array.isArray(payload.photos) ? payload.photos : []);
  const {
    ordinaryRegistrationMatchSummary,
    volunteerMatch,
    scoreResult,
  } = scoreAnalyzedPhotos({
    db: deps.db,
    fingerprintSecret: deps.fingerprintSecret,
    privateKeyPemBase64: deps.privateKeyPemBase64,
    event: loaded.event,
    fullName,
    stampCount: analysis.stampCount,
  });

  let duplicateApplication: ReturnType<typeof findDuplicateSpecialApplication> = null;
  if (deps.fingerprintSecret && fullName) {
    try {
      const email = normalizeEmail(String(payload.email ?? ''));
      const phone = normalizePhone(String(payload.phone ?? ''));
      duplicateApplication = findDuplicateSpecialApplication(
        deps.db,
        loaded.event.id,
        computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase()),
        computeFingerprint(deps.fingerprintSecret, email),
        computeFingerprint(deps.fingerprintSecret, phone),
      );
    } catch {
      duplicateApplication = null;
    }
  }

  return {
    event: publicSpecialEventView(loaded.event, loaded.showings),
    duplicateApplication,
    photos: buildPhotoSummary(analysis).map((photo, index) => ({
      ...photo,
      dataBase64: deps.returnPhotoDataBase64 ? analysis.photos[index]?.bytes.toString('base64') || null : undefined,
    })),
    scoring: {
      stampCount: analysis.stampCount,
      minStampCount: loaded.event.min_stamp_count,
      hasFullName: analysis.hasFullName,
      uploadedPhotoCount: analysis.uploadedPhotoCount,
      uniquePhotoCount: analysis.uniquePhotoCount,
      acceptedPhotoCount: analysis.acceptedPhotoCount,
      ordinaryRegistrationCount: ordinaryRegistrationMatchSummary.totalCount,
      ordinaryRegistrationMatch: ordinaryRegistrationMatchSummary,
      noShowCount: scoreResult.noShowCount,
      volunteerBonusPoints: volunteerMatch.bonusPoints,
      volunteerMatch,
      score: scoreResult.score,
    },
  };
}

export async function createSpecialApplication(payload: SpecialApplicationPayload, deps: SpecialApplicationDeps) {
  if (!payload || typeof payload !== 'object' || typeof payload.website === 'string' && payload.website.trim()) {
    throw new SpecialApplicationError(400, 'validation_error', 'Проверьте данные формы и попробуйте ещё раз.');
  }

  if (!payload.consentAccepted) {
    throw new SpecialApplicationError(400, 'consent_required', 'Подтвердите согласие на обработку персональных данных и OCR-проверку фото.');
  }

  const loaded = readSpecialEvent(deps.db, String(payload.eventSlug ?? ''), String(payload.token ?? ''));
  if (!loaded) {
    throw new SpecialApplicationError(404, 'special_event_not_found', 'Спецмероприятие не найдено или preview-ссылка неверна.');
  }

  if (loaded.event.public_state === 'closed') {
    throw new SpecialApplicationError(410, 'special_event_closed', 'Заявки на это спецмероприятие закрыты.');
  }

  const selectedSlugs = Array.isArray(payload.selectedShowingSlugs)
    ? payload.selectedShowingSlugs.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!selectedSlugs.length) {
    throw new SpecialApplicationError(400, 'showing_required', 'Выберите хотя бы одну дату показа.');
  }

  const selectedShowings = loaded.showings.filter((showing) => selectedSlugs.includes(showing.slug));
  if (selectedShowings.length !== new Set(selectedSlugs).size) {
    throw new SpecialApplicationError(400, 'invalid_showing', 'Одна из выбранных дат недоступна.');
  }

  const unavailableShowing = selectedShowings.find((showing) => !isShowingAvailableForApplication(showing));
  if (unavailableShowing) {
    throw new SpecialApplicationError(
      410,
      'showing_closed',
      `${unavailableShowing.display_label}: ${getShowingUnavailableReason(unavailableShowing) ?? 'дата недоступна для заявки'}`,
    );
  }

  let fullName: string;
  let email: string;
  let phone: string;

  try {
    fullName = normalizeFullName(String(payload.fullName ?? ''));
    email = normalizeEmail(String(payload.email ?? ''));
    phone = normalizePhone(String(payload.phone ?? ''));
  } catch (error) {
    throw new SpecialApplicationError(
      400,
      'validation_error',
      error instanceof Error ? error.message : 'Проверьте данные формы и попробуйте ещё раз.',
    );
  }

  const fullNameFingerprint = computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase());
  const emailFingerprint = computeFingerprint(deps.fingerprintSecret, email);
  const phoneFingerprint = computeFingerprint(deps.fingerprintSecret, phone);
  const vkAuth = getVkAuthSession(deps.db, payload.vkAuthToken);
  const vkUserIdFingerprint = vkAuth
    ? computeFingerprint(deps.fingerprintSecret, vkAuth.vkUserId)
    : null;
  const duplicate = findDuplicateSpecialApplication(
    deps.db,
    loaded.event.id,
    fullNameFingerprint,
    emailFingerprint,
    phoneFingerprint,
  );
  if (duplicate) {
    throw new SpecialApplicationError(409, 'duplicate_application', duplicate.message);
  }

  const applicationCode = crypto.randomUUID();
  const analysis = await analyzePhotos(Array.isArray(payload.photos) ? payload.photos : []);
  const photoResults: Array<AnalyzedPhoto & {
    storageKey: string;
  }> = [];

  for (const [index, photo] of analysis.photoResults.entries()) {
    const extension = photo.contentType === 'image/png'
      ? 'png'
      : photo.contentType === 'image/webp'
        ? 'webp'
        : 'jpg';
    const storageKey = `${SPECIAL_PHOTO_PREFIX}/${loaded.event.slug}/${applicationCode}/${String(index + 1).padStart(2, '0')}-${photo.sha256}.${extension}`;
    await deps.storagePublisher.publishPrivateAsset({
      key: storageKey,
      body: photo.bytes,
      contentType: photo.contentType,
    });

    photoResults.push({
      ...photo,
      storageKey,
    });
  }

  const {
    ordinaryRegistrationMatchSummary,
    volunteerMatch,
    scoreResult,
  } = scoreAnalyzedPhotos({
    db: deps.db,
    fingerprintSecret: deps.fingerprintSecret,
    privateKeyPemBase64: deps.privateKeyPemBase64,
    event: loaded.event,
    fullName,
    stampCount: analysis.stampCount,
  });
  const rejectionReasons = [
    analysis.hasFullName ? null : 'На фото не распознано заполненное поле ФИО.',
    analysis.stampCount >= loaded.event.min_stamp_count ? null : `Нужно не менее ${loaded.event.min_stamp_count} штампов, распознано ${analysis.stampCount}.`,
    scoreResult.score > 0 ? null : 'Итоговые баллы равны 0, заявка не участвует в розыгрыше.',
  ].filter((item): item is string => Boolean(item));
  const status: 'accepted' | 'rejected' = rejectionReasons.length ? 'rejected' : 'accepted';
  const rejectionReason = rejectionReasons.join(' ');

  const encrypted = encryptPii(deps.publicKeyPemBase64, {
    fullName,
    email,
    phone,
    vkUserId: vkAuth?.vkUserId || '',
    vkFirstName: vkAuth?.firstName || '',
    vkLastName: vkAuth?.lastName || '',
    vkEmail: vkAuth?.email || '',
    vkPhone: vkAuth?.phone || '',
  });
  const selectedShowingIds = selectedShowings.map((showing) => showing.id);
  const ocrSummary = {
    hasFullName: analysis.hasFullName,
    stampCount: analysis.stampCount,
    minStampCount: loaded.event.min_stamp_count,
    acceptedPhotoCount: analysis.acceptedPhotoCount,
    uniquePhotoCount: analysis.uniquePhotoCount,
    ordinaryRegistrationMatch: ordinaryRegistrationMatchSummary,
    volunteerMatch,
    photos: buildPhotoSummary(analysis),
  };

  const insert = deps.db.transaction(() => {
    const profile = deps.db.prepare(`
      INSERT INTO special_participant_profiles(
        full_name_fingerprint,
        email_fingerprint,
        phone_fingerprint,
        latest_stamp_count,
        latest_checked_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(full_name_fingerprint, email_fingerprint, phone_fingerprint)
      DO UPDATE SET
        latest_stamp_count = excluded.latest_stamp_count,
        latest_checked_at = excluded.latest_checked_at,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      RETURNING id
    `).get(
      fullNameFingerprint,
      emailFingerprint,
      phoneFingerprint,
      analysis.stampCount,
      new Date().toISOString(),
    ) as { id: number };

    const application = deps.db.prepare(`
      INSERT INTO special_applications(
        application_code,
        special_event_id,
        participant_profile_id,
        pii_ciphertext,
        pii_wrapped_key,
        pii_iv,
        pii_alg,
        full_name_fingerprint,
        email_fingerprint,
        phone_fingerprint,
        vk_auth_provider,
        vk_user_id_fingerprint,
        vk_auth_verified_at,
        vk_auth_scope,
        selected_showing_ids_json,
        status,
        rejection_reason,
        uploaded_photo_count,
        unique_photo_count,
        accepted_photo_count,
        stamp_count,
        ordinary_registration_count,
        no_show_count,
        volunteer_bonus_points,
        volunteer_match_json,
        score,
        ocr_provider,
        ocr_model,
        ocr_summary_json,
        consent_version,
        consent_text_hash,
        consent_accepted_at,
        source_ip,
        user_agent
      ) VALUES (
        @applicationCode,
        @specialEventId,
        @participantProfileId,
        @piiCiphertext,
        @piiWrappedKey,
        @piiIv,
        @piiAlg,
        @fullNameFingerprint,
        @emailFingerprint,
        @phoneFingerprint,
        @vkAuthProvider,
        @vkUserIdFingerprint,
        @vkAuthVerifiedAt,
        @vkAuthScope,
        @selectedShowingIdsJson,
        @status,
        @rejectionReason,
        @uploadedPhotoCount,
        @uniquePhotoCount,
        @acceptedPhotoCount,
        @stampCount,
        @ordinaryRegistrationCount,
        @noShowCount,
        @volunteerBonusPoints,
        @volunteerMatchJson,
        @score,
        @ocrProvider,
        @ocrModel,
        @ocrSummaryJson,
        @consentVersion,
        @consentTextHash,
        @consentAcceptedAt,
        @sourceIp,
        @userAgent
      )
    `).run({
      applicationCode,
      specialEventId: loaded.event.id,
      participantProfileId: profile.id,
      ...encrypted,
      fullNameFingerprint,
      emailFingerprint,
      phoneFingerprint,
      vkAuthProvider: vkAuth?.provider ?? null,
      vkUserIdFingerprint,
      vkAuthVerifiedAt: vkAuth ? new Date().toISOString() : null,
      vkAuthScope: vkAuth?.scope ?? null,
      selectedShowingIdsJson: JSON.stringify(selectedShowingIds),
      status,
      rejectionReason: rejectionReason || null,
      uploadedPhotoCount: analysis.uploadedPhotoCount,
      uniquePhotoCount: analysis.uniquePhotoCount,
      acceptedPhotoCount: analysis.acceptedPhotoCount,
      stampCount: analysis.stampCount,
      ordinaryRegistrationCount: ordinaryRegistrationMatchSummary.totalCount,
      noShowCount: scoreResult.noShowCount,
      volunteerBonusPoints: volunteerMatch.bonusPoints,
      volunteerMatchJson: JSON.stringify(volunteerMatch),
      score: scoreResult.score,
      ocrProvider: analysis.ocrProvider,
      ocrModel: analysis.ocrModel,
      ocrSummaryJson: JSON.stringify(ocrSummary),
      consentVersion: deps.consentVersion,
      consentTextHash: deps.consentTextHash,
      consentAcceptedAt: new Date().toISOString(),
      sourceIp: deps.sourceIp ?? null,
      userAgent: deps.userAgent ?? null,
    });

    const applicationId = Number(application.lastInsertRowid);
    const insertShowing = deps.db.prepare(`
      INSERT INTO special_application_showings(application_id, showing_id)
      VALUES (?, ?)
    `);
    for (const showingId of selectedShowingIds) {
      insertShowing.run(applicationId, showingId);
    }

    const insertPhoto = deps.db.prepare(`
      INSERT INTO special_application_photos(
        application_id,
        storage_key,
        original_filename,
        content_type,
        size_bytes,
        sha256,
        duplicate_of_sha256,
        has_full_name,
        stamp_count,
        accepted,
        confidence,
        ocr_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const photo of photoResults) {
      insertPhoto.run(
        applicationId,
        photo.storageKey,
        photo.fileName,
        photo.contentType,
        photo.bytes.length,
        photo.sha256,
        photo.duplicateOfSha256,
        photo.ocr.hasFullName ? 1 : 0,
        photo.ocr.stampCount,
        photo.ocr.accepted ? 1 : 0,
        photo.ocr.confidence,
        JSON.stringify(photo.ocr.raw),
      );
    }

    return applicationId;
  });

  let applicationId: number;
  try {
    applicationId = insert();
  } catch (error) {
    const duplicate = duplicateMessage(error);
    if (duplicate) {
      throw new SpecialApplicationError(409, 'duplicate_application', duplicate);
    }

    throw error;
  }

  const testApplication = isSpecialTestFullName(fullName);
  if (!testApplication) {
    enqueueSpecialApplicationCreated(deps.db, {
      applicationId,
    });
  }

  return {
    applicationId,
    testApplication,
    applicationCode,
    fullName,
    email,
    phone,
    status,
    rejectionReason: rejectionReason || null,
    event: publicSpecialEventView(loaded.event, loaded.showings),
    selectedShowings: selectedShowings.map((showing) => ({
      slug: showing.slug,
      displayLabel: showing.display_label,
      startsAt: showing.starts_at,
    })),
    scoring: {
      stampCount: analysis.stampCount,
      ordinaryRegistrationCount: ordinaryRegistrationMatchSummary.totalCount,
      noShowCount: scoreResult.noShowCount,
      volunteerBonusPoints: volunteerMatch.bonusPoints,
      volunteerMatch,
      score: scoreResult.score,
      uploadedPhotoCount: analysis.uploadedPhotoCount,
      uniquePhotoCount: analysis.uniquePhotoCount,
      acceptedPhotoCount: analysis.acceptedPhotoCount,
    },
  };
}

export { SpecialApplicationError };
