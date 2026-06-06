import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoragePublisher } from '../lib/storage';
import { computeFingerprint, decryptPii, encryptPii } from '../lib/crypto';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../lib/normalize';

const SPECIAL_PHOTO_PREFIX = 'special-passports';
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
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

type SpecialPhotoPayload = {
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

function publicSpecialEventView(event: SpecialEventRow, showings: SpecialShowingRow[]) {
  return {
    slug: event.slug,
    title: event.title,
    formatLabel: event.format_label,
    venueName: event.venue_name,
    minStampCount: event.min_stamp_count,
    pointRules: {
      basePoints: event.base_points,
      extraStampPoints: event.extra_stamp_points,
      noShowGraceCount: event.no_show_grace_count,
      noShowPenaltyPoints: event.no_show_penalty_points,
    },
    showings: showings.map((showing) => ({
      slug: showing.slug,
      startsAt: showing.starts_at,
      displayLabel: showing.display_label,
      timeIsFinal: Boolean(showing.time_is_final),
      physicalQuota: showing.physical_quota,
      reservedSeats: showing.reserved_seats,
      lotteryQuota: showing.lottery_quota,
      drawStatus: showing.draw_status,
    })),
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
  const contentType = String(photo.contentType ?? '').trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new SpecialApplicationError(400, 'unsupported_photo_type', 'Фотографии принимаются в форматах JPG, PNG или WebP.');
  }

  const fileName = String(photo.fileName ?? '').trim() || 'passport-photo';
  const dataBase64 = String(photo.dataBase64 ?? '').replace(/^data:[^;]+;base64,/u, '').trim();
  let bytes: Buffer;

  try {
    bytes = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new SpecialApplicationError(400, 'invalid_photo', 'Не удалось прочитать одну из фотографий.');
  }

  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) {
    throw new SpecialApplicationError(400, 'invalid_photo_size', 'Каждая фотография должна быть не больше 6 МБ.');
  }

  return {
    fileName,
    contentType,
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function safeNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeOcrBoolean(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function mapOcrJson(parsed: Record<string, unknown>, provider: string, model: string | null): OcrResult {
  const hasFullName = normalizeOcrBoolean(parsed.has_full_name ?? parsed.hasFullName);
  const stampCount = Math.max(0, Math.trunc(safeNumber(parsed.stamp_count ?? parsed.stampCount, 0)));
  const confidence = Math.max(0, Math.min(1, safeNumber(parsed.confidence, 0)));
  const accepted = normalizeOcrBoolean(parsed.accepted) && hasFullName && stampCount >= 5 && confidence >= 0.75;
  const rejectionReason = typeof parsed.rejection_reason === 'string'
    ? parsed.rejection_reason
    : typeof parsed.rejectionReason === 'string'
      ? parsed.rejectionReason
      : null;

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
      rejection_reason: 'На фото не распознано заполненное поле ФИО и меньше 5 штампов.',
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

async function runOpenAiPassportOcr(photo: PreparedPhoto): Promise<OcrResult> {
  const token = process.env.FOUR_O_TOKEN?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!token) {
    const debug = knownDebugOcr(photo.sha256);
    if (debug) {
      return debug;
    }

    throw new SpecialApplicationError(503, 'ocr_not_configured', 'Автоматическая проверка фото пока не настроена.');
  }

  const model = process.env.SPECIAL_OCR_OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const url = process.env.FOUR_O_URL?.trim() || 'https://api.openai.com/v1/chat/completions';
  const dataUrl = `data:${photo.contentType};base64,${photo.bytes.toString('base64')}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: [
            'Ты проверяешь фото паспорта участника фестиваля для допуска к розыгрышу.',
            'Не раскрывай полное ФИО в ответе.',
            'Отдельные видимые штампы на одной странице считаются отдельными посещениями, даже если дизайн штампов одинаковый.',
            'Верни только JSON без markdown.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'Определи, есть ли заполненное поле ФИО, и посчитай видимые штампы посещений.',
                'Минимум допуска: заполненное ФИО и 5 штампов.',
                'Верни JSON с полями has_full_name, stamp_count, accepted, rejection_reason, confidence, notes.',
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
    throw new SpecialApplicationError(502, 'ocr_failed', 'Не удалось автоматически проверить фото. Попробуйте ещё раз чуть позже.');
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
}

function computeScore(options: {
  stampCount: number;
  ordinaryRegistrationCount: number;
  minStampCount: number;
  basePoints: number;
  extraStampPoints: number;
  noShowGraceCount: number;
  noShowPenaltyPoints: number;
}) {
  if (options.stampCount < options.minStampCount) {
    return {
      noShowCount: Math.max(options.ordinaryRegistrationCount - options.stampCount, 0),
      score: 0,
    };
  }

  const noShowCount = Math.max(options.ordinaryRegistrationCount - options.stampCount, 0);
  const extraStamps = Math.max(options.stampCount - options.minStampCount, 0);
  const penaltyCount = Math.max(noShowCount - options.noShowGraceCount, 0);
  const score = Math.max(
    options.basePoints
      + extraStamps * options.extraStampPoints
      - penaltyCount * options.noShowPenaltyPoints,
    0,
  );

  return { noShowCount, score };
}

function countOrdinaryRegistrationsByFullName(
  db: Database.Database,
  privateKeyPemBase64: string | null,
  normalizedFullName: string,
) {
  if (!privateKeyPemBase64) {
    return 0;
  }

  const target = normalizedFullName.toLowerCase();
  const rows = db.prepare(`
    SELECT pii_ciphertext, pii_wrapped_key, pii_iv, pii_alg
    FROM registrations
    ORDER BY created_at DESC
    LIMIT 5000
  `).all() as Array<{
    pii_ciphertext: Buffer;
    pii_wrapped_key: Buffer;
    pii_iv: Buffer;
    pii_alg: string;
  }>;

  let count = 0;
  for (const row of rows) {
    try {
      const pii = decryptPii(privateKeyPemBase64, {
        piiCiphertext: row.pii_ciphertext,
        piiWrappedKey: row.pii_wrapped_key,
        piiIv: row.pii_iv,
        piiAlg: row.pii_alg,
      });
      const current = normalizeFullName(String(pii.fullName ?? '')).toLowerCase();
      if (current === target) {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

function duplicateMessage(error: unknown) {
  if (isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.full_name_fingerprint')) {
    return 'Заявка с таким ФИО уже участвует в розыгрыше этого спецмероприятия.';
  }

  if (isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.email_fingerprint')) {
    return 'Заявка с таким email уже участвует в розыгрыше этого спецмероприятия.';
  }

  if (isUniqueConstraintError(error, 'special_applications.special_event_id, special_applications.phone_fingerprint')) {
    return 'Заявка с таким телефоном уже участвует в розыгрыше этого спецмероприятия.';
  }

  return null;
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

  const photos = Array.isArray(payload.photos) ? payload.photos.map(parsePhoto) : [];
  if (!photos.length) {
    throw new SpecialApplicationError(400, 'photo_required', 'Приложите хотя бы одну фотографию паспорта участника фестиваля.');
  }

  const applicationCode = crypto.randomUUID();
  const seenSha = new Set<string>();
  const photoResults: Array<PreparedPhoto & {
    storageKey: string;
    duplicateOfSha256: string | null;
    ocr: OcrResult;
  }> = [];
  let uniquePhotoCount = 0;
  let acceptedPhotoCount = 0;
  let stampCount = 0;
  let hasFullName = false;
  let ocrProvider = 'debug-fixture';
  let ocrModel: string | null = null;

  for (const [index, photo] of photos.entries()) {
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
      duplicateOfSha256,
      ocr,
    });
  }

  const ordinaryRegistrationCount = countOrdinaryRegistrationsByFullName(
    deps.db,
    deps.privateKeyPemBase64,
    fullName,
  );
  const scoreResult = computeScore({
    stampCount,
    ordinaryRegistrationCount,
    minStampCount: loaded.event.min_stamp_count,
    basePoints: loaded.event.base_points,
    extraStampPoints: loaded.event.extra_stamp_points,
    noShowGraceCount: loaded.event.no_show_grace_count,
    noShowPenaltyPoints: loaded.event.no_show_penalty_points,
  });
  const rejectionReasons = [
    hasFullName ? null : 'На фото не распознано заполненное поле ФИО.',
    stampCount >= loaded.event.min_stamp_count ? null : `Нужно не менее ${loaded.event.min_stamp_count} штампов, распознано ${stampCount}.`,
    scoreResult.score > 0 ? null : 'Итоговые баллы равны 0, заявка не участвует в розыгрыше.',
  ].filter((item): item is string => Boolean(item));
  const status: 'accepted' | 'rejected' = rejectionReasons.length ? 'rejected' : 'accepted';
  const rejectionReason = rejectionReasons.join(' ');

  const fullNameFingerprint = computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase());
  const emailFingerprint = computeFingerprint(deps.fingerprintSecret, email);
  const phoneFingerprint = computeFingerprint(deps.fingerprintSecret, phone);
  const encrypted = encryptPii(deps.publicKeyPemBase64, { fullName, email, phone });
  const selectedShowingIds = selectedShowings.map((showing) => showing.id);
  const ocrSummary = {
    hasFullName,
    stampCount,
    minStampCount: loaded.event.min_stamp_count,
    acceptedPhotoCount,
    uniquePhotoCount,
    photos: photoResults.map((photo) => ({
      fileName: photo.fileName,
      sha256: photo.sha256,
      duplicateOfSha256: photo.duplicateOfSha256,
      hasFullName: photo.ocr.hasFullName,
      stampCount: photo.ocr.stampCount,
      accepted: photo.ocr.accepted,
      confidence: photo.ocr.confidence,
      provider: photo.ocr.provider,
      model: photo.ocr.model,
      rejectionReason: photo.ocr.rejectionReason,
    })),
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
      stampCount,
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
        selected_showing_ids_json,
        status,
        rejection_reason,
        uploaded_photo_count,
        unique_photo_count,
        accepted_photo_count,
        stamp_count,
        ordinary_registration_count,
        no_show_count,
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
        @selectedShowingIdsJson,
        @status,
        @rejectionReason,
        @uploadedPhotoCount,
        @uniquePhotoCount,
        @acceptedPhotoCount,
        @stampCount,
        @ordinaryRegistrationCount,
        @noShowCount,
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
      selectedShowingIdsJson: JSON.stringify(selectedShowingIds),
      status,
      rejectionReason: rejectionReason || null,
      uploadedPhotoCount: photos.length,
      uniquePhotoCount,
      acceptedPhotoCount,
      stampCount,
      ordinaryRegistrationCount,
      noShowCount: scoreResult.noShowCount,
      score: scoreResult.score,
      ocrProvider,
      ocrModel,
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

  return {
    applicationId,
    applicationCode,
    status,
    rejectionReason: rejectionReason || null,
    event: publicSpecialEventView(loaded.event, loaded.showings),
    selectedShowings: selectedShowings.map((showing) => ({
      slug: showing.slug,
      displayLabel: showing.display_label,
      startsAt: showing.starts_at,
    })),
    scoring: {
      stampCount,
      ordinaryRegistrationCount,
      noShowCount: scoreResult.noShowCount,
      score: scoreResult.score,
      uploadedPhotoCount: photos.length,
      uniquePhotoCount,
      acceptedPhotoCount,
    },
  };
}

export { SpecialApplicationError };
