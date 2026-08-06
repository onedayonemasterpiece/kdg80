#!/usr/bin/env python3
"""Apply the small server patch required for reversible special-event E2E tests."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATIONS = ROOT / "registration/src/services/special-applications.ts"
SPECIAL_API = ROOT / "registration/src/api/special.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Cannot find expected {label}; refusing to guess.")
    return text.replace(old, new, 1)


def patch_applications() -> bool:
    original = APPLICATIONS.read_text(encoding="utf-8")
    text = original
    text = replace_once(
        text,
        "import { enqueueSpecialApplicationCreated } from './telegram-outbox';\n",
        "import { enqueueSpecialApplicationCreated } from './telegram-outbox';\n"
        "import { isSpecialTestFullName } from './special-test-cleanup';\n",
        "special-test cleanup import",
    )
    text = replace_once(
        text,
        "  enqueueSpecialApplicationCreated(deps.db, {\n"
        "    applicationId,\n"
        "  });\n\n"
        "  return {\n"
        "    applicationId,\n",
        "  const testApplication = isSpecialTestFullName(fullName);\n"
        "  if (!testApplication) {\n"
        "    enqueueSpecialApplicationCreated(deps.db, {\n"
        "      applicationId,\n"
        "    });\n"
        "  }\n\n"
        "  return {\n"
        "    applicationId,\n"
        "    testApplication,\n",
        "test-application notification guard",
    )
    if text == original:
        return False
    APPLICATIONS.write_text(text, encoding="utf-8")
    return True


EMAIL_HELPER = r'''
type CreatedSpecialApplication = Awaited<ReturnType<typeof createSpecialApplication>>;

async function sendSpecialApplicationEmailNotification(
  created: CreatedSpecialApplication,
  deps: SpecialApiDeps,
  logger: FastifyBaseLogger,
  route: string,
): Promise<EmailSendResult> {
  if (created.testApplication) {
    logger.info({
      route,
      applicationId: created.applicationId,
      status: created.status,
      emailSent: false,
      reason: 'test_application_suppressed',
    }, 'special_application_email_notification_suppressed');
    return {
      sent: false,
      provider: 'yandex-postbox',
      messageId: null,
      reason: 'test_application_suppressed',
    };
  }

  try {
    const emailNotification = await deps.emailNotifications.sendSpecialApplicationCreated(created);
    recordEmailNotification(deps.db, {
      entityType: 'special_application',
      entityId: created.applicationId,
      template: 'special_application_created',
      recipientEmail: created.email,
      subject: emailNotification.subject || `Заявка на спецмероприятие: ${created.event.title}`,
      configurationSetName: deps.postboxConfigurationSetName,
      fingerprintSecret: deps.fingerprintSecret,
      result: emailNotification,
    });
    logger.info({
      route,
      applicationId: created.applicationId,
      status: created.status,
      emailSent: emailNotification.sent,
      messageId: emailNotification.messageId,
      reason: emailNotification.reason,
    }, 'special_application_email_notification_result');
    return emailNotification;
  } catch (error) {
    logger.error({ err: error, route, applicationId: created.applicationId }, 'special_application_email_notification_failed');
    return {
      sent: false,
      provider: 'yandex-postbox',
      messageId: null,
      reason: 'send_failed',
    };
  }
}

function testCleanupTokenFor(created: CreatedSpecialApplication, deps: SpecialApiDeps) {
  return created.testApplication && deps.fingerprintSecret
    ? createSpecialTestCleanupToken(deps.fingerprintSecret, created.applicationCode)
    : undefined;
}
'''.lstrip("\n")

CLEANUP_ROUTE = r'''
  app.delete('/api/v1/special/test-applications/:applicationCode', {
    config: {
      rateLimit: {
        max: 6,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    noIndex(reply);

    if (!deps.fingerprintSecret || !deps.privateKeyPemBase64) {
      reply.code(503);
      return {
        error: 'special_test_cleanup_not_ready',
        message: 'Безопасное удаление тестовой заявки пока не настроено на сервере.',
      };
    }

    const applicationCode = String((request.params as Record<string, unknown>).applicationCode ?? '').trim();
    const cleanupToken = request.body && typeof request.body === 'object'
      ? String((request.body as Record<string, unknown>).cleanupToken ?? '')
      : '';

    if (!applicationCode || !verifySpecialTestCleanupToken(deps.fingerprintSecret, applicationCode, cleanupToken)) {
      reply.code(403);
      return {
        error: 'invalid_test_cleanup_token',
        message: 'Токен удаления тестовой заявки недействителен.',
      };
    }

    try {
      const result = await cleanupSpecialTestApplication(deps.db, {
        applicationCode,
        privateKeyPemBase64: deps.privateKeyPemBase64,
        storagePublisher: deps.storagePublisher,
      });

      if (!result) {
        reply.code(404);
        return {
          error: 'test_application_not_found',
          message: 'Тестовая заявка уже удалена или не найдена.',
        };
      }

      request.log.info({
        applicationCode,
        removedPrivateAssets: result.removedPrivateAssets,
        removedProfile: result.removedProfile,
      }, 'special_test_application_cleaned');
      return {
        status: 'deleted',
        ...result,
      };
    } catch (error) {
      if (error instanceof SpecialTestCleanupError) {
        reply.code(error.statusCode);
        return {
          error: error.code,
          message: error.message,
        };
      }

      request.log.error({ err: error, applicationCode }, 'special_test_application_cleanup_failed');
      reply.code(500);
      return {
        error: 'server_error',
        message: 'Не удалось удалить тестовую заявку.',
      };
    }
  });

'''


def patch_special_api() -> bool:
    original = SPECIAL_API.read_text(encoding="utf-8")
    text = original
    text = replace_once(
        text,
        "import type { FastifyInstance } from 'fastify';\n",
        "import type { FastifyBaseLogger, FastifyInstance } from 'fastify';\n",
        "Fastify logger type import",
    )
    text = replace_once(
        text,
        "import type { EmailNotificationService } from '../services/email-notifications';\n",
        "import type { EmailNotificationService, EmailSendResult } from '../services/email-notifications';\n",
        "EmailSendResult import",
    )
    text = replace_once(
        text,
        "import { recordEmailNotification } from '../services/email-stats';\n",
        "import { recordEmailNotification } from '../services/email-stats';\n"
        "import {\n"
        "  cleanupSpecialTestApplication,\n"
        "  createSpecialTestCleanupToken,\n"
        "  SpecialTestCleanupError,\n"
        "  verifySpecialTestCleanupToken,\n"
        "} from '../services/special-test-cleanup';\n",
        "special test cleanup API imports",
    )
    text = replace_once(
        text,
        "export async function registerSpecialApi(app: FastifyInstance, deps: SpecialApiDeps) {\n",
        EMAIL_HELPER + "\nexport async function registerSpecialApi(app: FastifyInstance, deps: SpecialApiDeps) {\n",
        "email helper insertion point",
    )
    text = replace_once(
        text,
        "  app.post('/api/v1/special/applications', {\n",
        CLEANUP_ROUTE + "  app.post('/api/v1/special/applications', {\n",
        "test cleanup route insertion point",
    )

    pattern = re.compile(
        r"      let emailNotification;\n      try \{.*?\n      \}\n\n      reply\.code\(201\);",
        re.DOTALL,
    )
    route_names = iter(("applications-json", "applications-multipart"))

    def replace_email_block(_match: re.Match[str]) -> str:
        route = next(route_names)
        return (
            "      const emailNotification = await sendSpecialApplicationEmailNotification(\n"
            "        created,\n"
            "        deps,\n"
            "        request.log,\n"
            f"        '{route}',\n"
            "      );\n\n"
            "      reply.code(201);"
        )

    text, count = pattern.subn(replace_email_block, text, count=2)
    if count != 2 and "sendSpecialApplicationEmailNotification(" not in original:
        raise RuntimeError(f"Expected two email notification blocks, patched {count}.")

    response_old = (
        "      return {\n"
        "        ...created,\n"
        "        emailNotification,\n"
        "      };"
    )
    response_new = (
        "      return {\n"
        "        ...created,\n"
        "        emailNotification,\n"
        "        testCleanupToken: testCleanupTokenFor(created, deps),\n"
        "      };"
    )
    if response_new not in text:
        occurrences = text.count(response_old)
        if occurrences != 2:
            raise RuntimeError(f"Expected two special application responses, found {occurrences}.")
        text = text.replace(response_old, response_new)

    if text == original:
        return False
    SPECIAL_API.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    changed = []
    if patch_applications():
        changed.append(str(APPLICATIONS.relative_to(ROOT)))
    if patch_special_api():
        changed.append(str(SPECIAL_API.relative_to(ROOT)))
    print("Patched reversible special E2E support:")
    for item in changed:
        print(f"- {item}")
    if not changed:
        print("- already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
