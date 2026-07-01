import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { RegistrationPayload } from '../types';
import type { StoragePublisher } from '../lib/storage';
import { createRegistration, RegistrationError } from '../services/registrations';
import { listPublicEventStates } from '../services/catalog';
import type { EmailNotificationService } from '../services/email-notifications';

type RegistrationApiDeps = {
  db: Database.Database;
  allowedOrigins: string[];
  consentVersion: string;
  consentTextHash: string;
  fingerprintSecret: string | null;
  publicKeyPemBase64: string | null;
  publicTicketBaseUrl: string;
  ticketsPrefix: string;
  storagePublisher: StoragePublisher;
  syncPublicStateManifest: (reason: string) => Promise<boolean>;
  emailNotifications: EmailNotificationService;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, '');
}

function hasAllowedOrigin(originHeader: unknown, allowedOrigins: string[]) {
  if (typeof originHeader !== 'string' || !originHeader.trim()) {
    return false;
  }

  return allowedOrigins.includes(trimTrailingSlash(originHeader.trim()));
}

export async function registerRegistrationApi(app: FastifyInstance, deps: RegistrationApiDeps) {
  app.get('/api/v1/public/events/:slug', async (request, reply) => {
    const slug = (request.params as Record<string, string>).slug;
    const event = listPublicEventStates(deps.db, [slug])[0];

    if (!event) {
      reply.code(404);
      return {
        error: 'event_not_found',
      };
    }

    return event;
  });

  app.post('/api/v1/register', {
    config: {
      rateLimit: {
        max: 8,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    if (!deps.fingerprintSecret || !deps.publicKeyPemBase64) {
      reply.code(503);
      return {
        error: 'registration_not_ready',
        message: 'Регистрация пока не настроена на сервере.',
      };
    }

    if (!hasAllowedOrigin(request.headers.origin, deps.allowedOrigins)) {
      reply.code(403);
      return {
        error: 'origin_forbidden',
        message: 'Регистрация доступна только через официальный сайт фестиваля.',
      };
    }

    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      reply.code(415);
      return {
        error: 'unsupported_media_type',
        message: 'Форма регистрации принимает только JSON-запросы.',
      };
    }

    try {
      const payload = request.body as RegistrationPayload;
      const created = await createRegistration(payload, {
        db: deps.db,
        consentVersion: deps.consentVersion,
        consentTextHash: deps.consentTextHash,
        fingerprintSecret: deps.fingerprintSecret,
        publicKeyPemBase64: deps.publicKeyPemBase64,
        publicTicketBaseUrl: deps.publicTicketBaseUrl,
        ticketsPrefix: deps.ticketsPrefix,
        storagePublisher: deps.storagePublisher,
        sourceIp: request.ip,
        userAgent: request.headers['user-agent'],
      });

      void deps.syncPublicStateManifest(`registration:${payload.eventSlug}`);

      let emailNotification;
      try {
        emailNotification = await deps.emailNotifications.sendRegistrationCreated(created);
        request.log.info({
          eventSlug: created.eventSlug,
          emailSent: emailNotification.sent,
          messageId: emailNotification.messageId,
          reason: emailNotification.reason,
        }, 'registration_email_notification_result');
      } catch (error) {
        request.log.error({ err: error, eventSlug: created.eventSlug }, 'registration_email_notification_failed');
        emailNotification = {
          sent: false,
          provider: 'yandex-postbox' as const,
          messageId: null,
          reason: 'send_failed',
        };
      }

      reply.code(201);
      return {
        ...created,
        emailNotification,
      };
    } catch (error) {
      if (error instanceof RegistrationError) {
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error }, 'registration_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось завершить регистрацию. Попробуйте ещё раз чуть позже.',
      };
    }
  });
}
