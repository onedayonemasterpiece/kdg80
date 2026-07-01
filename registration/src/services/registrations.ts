import type Database from 'better-sqlite3';
import type { RegistrationPayload } from '../types';
import { normalizeEmail, normalizeFullName, normalizePhone } from '../lib/normalize';
import { computeFingerprint, encryptPii } from '../lib/crypto';
import { createPublicHash, createShortTicketId } from '../lib/ticket';
import type { StoragePublisher } from '../lib/storage';
import { publishTicketArtifacts } from './ticket-artifacts';
import { enqueueRegistrationCreated } from './telegram-outbox';
import { derivePublicState } from '../lib/public-state';

type RegistrationDeps = {
  db: Database.Database;
  consentVersion: string;
  consentTextHash: string;
  fingerprintSecret: string;
  publicKeyPemBase64: string;
  publicTicketBaseUrl: string;
  ticketsPrefix: string;
  storagePublisher: StoragePublisher;
  sourceIp?: string;
  userAgent?: string;
};

class RegistrationError extends Error {
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

function isBusyDatabaseError(error: unknown) {
  return error instanceof Error
    && (
      error.message.includes('database is locked')
      || error.message.includes('database is busy')
      || error.message.includes('SQLITE_BUSY')
    );
}

function readEventForRegistration(db: Database.Database, eventSlug: string) {
  return db.prepare(`
    SELECT
      id,
      slug,
      title,
      starts_at,
      ends_at,
      venue_name,
      hall_name,
      address,
      capacity,
      overbooking_percent,
      registration_limit,
      seats_taken,
      registration_public_state
    FROM events
    WHERE slug = ?
    LIMIT 1
  `).get(eventSlug) as
    | {
        id: number;
        slug: string;
        title: string;
        starts_at: string;
        ends_at: string;
        venue_name: string;
        hall_name: string;
        address: string;
        capacity: number;
        overbooking_percent: number;
        registration_limit: number;
        seats_taken: number;
        registration_public_state: 'open' | 'soon' | 'closed';
      }
    | undefined;
}

export async function createRegistration(payload: RegistrationPayload, deps: RegistrationDeps) {
  if (!payload || typeof payload !== 'object') {
    throw new RegistrationError(400, 'validation_error', 'Проверьте данные формы и попробуйте ещё раз.');
  }

  if (typeof payload.website === 'string' && payload.website.trim()) {
    throw new RegistrationError(400, 'validation_error', 'Проверьте данные формы и попробуйте ещё раз.');
  }

  if (typeof payload.eventSlug !== 'string' || !payload.eventSlug.trim()) {
    throw new RegistrationError(400, 'validation_error', 'Не удалось определить событие для регистрации.');
  }

  if (!payload.consentAccepted) {
    throw new RegistrationError(400, 'consent_required', 'Подтвердите согласие на обработку персональных данных, чтобы продолжить.');
  }

  let fullName: string;
  let email: string;
  let phone: string;

  try {
    fullName = normalizeFullName(String(payload.fullName ?? ''));
    email = normalizeEmail(String(payload.email ?? ''));
    phone = normalizePhone(String(payload.phone ?? ''));
  } catch (error) {
    throw new RegistrationError(
      400,
      'validation_error',
      error instanceof Error ? error.message : 'Проверьте данные формы и попробуйте ещё раз.',
    );
  }

  const event = readEventForRegistration(deps.db, payload.eventSlug);

  if (!event) {
    throw new RegistrationError(404, 'event_not_found', 'Событие не найдено.');
  }

  const publicState = derivePublicState(event);
  if (publicState === 'past') {
    throw new RegistrationError(409, 'event_past', 'Регистрация на прошедшее событие недоступна.');
  }

  if (publicState === 'registration_closed' || publicState === 'registration_soon') {
    throw new RegistrationError(409, 'registration_closed', 'Регистрация на это событие сейчас закрыта.');
  }

  if (publicState === 'sold_out') {
    throw new RegistrationError(409, 'sold_out', 'Свободные места закончились.');
  }

  const fullNameFingerprint = computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase());
  const emailFingerprint = computeFingerprint(deps.fingerprintSecret, email);
  const phoneFingerprint = computeFingerprint(deps.fingerprintSecret, phone);
  const encrypted = encryptPii(deps.publicKeyPemBase64, {
    fullName,
    email,
    phone,
  });

  const insertRegistration = deps.db.prepare(`
    INSERT INTO registrations(
      event_id,
      pii_ciphertext,
      pii_wrapped_key,
      pii_iv,
      pii_alg,
      full_name_fingerprint,
      email_fingerprint,
      phone_fingerprint,
      consent_version,
      consent_text_hash,
      consent_accepted_at,
      source_ip,
      user_agent,
      test_run_id
    ) VALUES (
      @eventId,
      @piiCiphertext,
      @piiWrappedKey,
      @piiIv,
      @piiAlg,
      @fullNameFingerprint,
      @emailFingerprint,
      @phoneFingerprint,
      @consentVersion,
      @consentTextHash,
      @consentAcceptedAt,
      @sourceIp,
      @userAgent,
      @testRunId
    )
  `);

  const reserveSeat = deps.db.prepare(`
    UPDATE events
    SET seats_taken = seats_taken + 1,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = @eventId
      AND seats_taken < registration_limit
      AND registration_public_state = 'open'
  `);

  const insertTicket = deps.db.prepare(`
    INSERT INTO tickets(
      registration_id,
      public_hash,
      short_ticket_id,
      public_url,
      pdf_url,
      ics_url
    ) VALUES (
      @registrationId,
      @publicHash,
      @shortTicketId,
      @publicUrl,
      @pdfUrl,
      @icsUrl
    )
  `);

  const readSeatsTaken = deps.db.prepare(`
    SELECT seats_taken
    FROM events
    WHERE id = ?
    LIMIT 1
  `);

  const reserveAndInsert = deps.db.transaction(() => {
    const seatUpdate = reserveSeat.run({ eventId: event.id });
    if (seatUpdate.changes === 0) {
      throw new RegistrationError(409, 'sold_out', 'Свободные места закончились.');
    }

    const registrationResult = insertRegistration.run({
      eventId: event.id,
      ...encrypted,
      fullNameFingerprint,
      emailFingerprint,
      phoneFingerprint,
      consentVersion: deps.consentVersion,
      consentTextHash: deps.consentTextHash,
      consentAcceptedAt: new Date().toISOString(),
      sourceIp: deps.sourceIp ?? null,
      userAgent: deps.userAgent ?? null,
      testRunId: payload.testRunId ?? null,
    });

    const registrationId = Number(registrationResult.lastInsertRowid);
    const publicHash = createPublicHash();
    const shortTicketId = createShortTicketId();
    const seatsRow = readSeatsTaken.get(event.id) as { seats_taken: number };

    return {
      registrationId,
      eventId: event.id,
      publicHash,
      shortTicketId,
      seatsLeftAfter: Math.max(event.registration_limit - seatsRow.seats_taken, 0),
    };
  });

  let created: {
    registrationId: number;
    eventId: number;
    publicHash: string;
    shortTicketId: string;
    seatsLeftAfter: number;
  };

  try {
    created = reserveAndInsert();
  } catch (error) {
    if (error instanceof RegistrationError) {
      throw error;
    }

    if (isUniqueConstraintError(error, 'registrations.event_id, registrations.email_fingerprint')) {
      throw new RegistrationError(409, 'duplicate_email', 'На это событие уже есть регистрация с таким email.');
    }

    if (isUniqueConstraintError(error, 'registrations.event_id, registrations.phone_fingerprint')) {
      throw new RegistrationError(409, 'duplicate_phone', 'На это событие уже есть регистрация с таким номером телефона.');
    }

    if (isBusyDatabaseError(error)) {
      throw new RegistrationError(429, 'retry_later', 'Слишком много одновременных попыток. Попробуйте ещё раз через 10–15 секунд.');
    }

    throw error;
  }

  const artifacts = await publishTicketArtifacts(deps.storagePublisher, {
    publicHash: created.publicHash,
    eventSlug: event.slug,
    shortTicketId: created.shortTicketId,
    ticketBaseUrl: deps.publicTicketBaseUrl,
    ticketsPrefix: deps.ticketsPrefix,
    fullName,
    email,
    phone,
    title: event.title,
    startsAt: event.starts_at,
    venueName: event.venue_name,
    hallName: event.hall_name,
    address: event.address,
  });

  insertTicket.run({
    registrationId: created.registrationId,
    publicHash: created.publicHash,
    shortTicketId: created.shortTicketId,
    publicUrl: artifacts.ticketUrl,
    pdfUrl: artifacts.pdfUrl,
    icsUrl: artifacts.icsUrl,
  });

  enqueueRegistrationCreated(deps.db, {
    registrationId: created.registrationId,
    eventId: created.eventId,
    seatsLeftAfter: created.seatsLeftAfter,
  });

  return {
    registrationId: created.registrationId,
    eventSlug: event.slug,
    eventTitle: event.title,
    startsAt: event.starts_at,
    venueName: event.venue_name,
    hallName: event.hall_name,
    address: event.address,
    fullName,
    email,
    phone,
    publicHash: created.publicHash,
    shortTicketId: created.shortTicketId,
    ...artifacts,
  };
}

export { RegistrationError };
