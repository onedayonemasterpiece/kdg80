import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { createSqliteBackup } from '../services/admin-maintenance';
import { buildRegistrationsXlsxBuffer, listAllRegistrationsForExport } from '../services/registration-exports';
import { buildVkSocialDailyReport, getVkSocialReport } from '../services/vk-social-monitoring';
import { buildEmailStatsReport, recordPostboxEvent } from '../services/email-stats';

type AdminApiDeps = {
  db: Database.Database;
  emergencyExportToken: string | null;
  privateKeyPemBase64: string | null;
};

function isAuthorized(authorizationHeader: string | string[] | undefined, expectedToken: string | null) {
  if (!expectedToken || typeof authorizationHeader !== 'string') {
    return false;
  }

  return authorizationHeader === `Bearer ${expectedToken}`;
}

export async function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps) {
  app.get('/api/v1/admin/emergency-export/registrations.xlsx', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    if (!deps.privateKeyPemBase64) {
      reply.code(503);
      return {
        error: 'private_key_missing',
      };
    }

    const rows = listAllRegistrationsForExport(deps.db, deps.privateKeyPemBase64);
    const buffer = await buildRegistrationsXlsxBuffer(rows);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', 'attachment; filename="registrations-all.xlsx"');
    return reply.send(buffer);
  });

  app.get('/api/v1/admin/emergency-export/backup.sqlite', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    const buffer = await createSqliteBackup(deps.db, 'registration-emergency-backup');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', 'attachment; filename="registration-backup.sqlite"');
    return reply.send(buffer);
  });


  app.get('/api/v1/admin/social/vk/daily-report', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    if (!deps.privateKeyPemBase64) {
      reply.code(503);
      return {
        error: 'private_key_missing',
      };
    }

    const query = request.query as Record<string, unknown>;
    return buildVkSocialDailyReport(deps.db, deps.privateKeyPemBase64, {
      hours: Number(query.hours ?? 24),
      mode: query.mode === 'rolling' ? 'rolling' : 'delta',
      currentRunId: Number(query.runId ?? 0) || undefined,
    });
  });

  app.get('/api/v1/admin/social/vk/report', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    return getVkSocialReport(deps.db);
  });

  app.get('/api/v1/admin/email/stats', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    const query = request.query as Record<string, unknown>;
    const date = typeof query.date === 'string' && query.date.trim()
      ? query.date.trim()
      : new Date().toISOString().slice(0, 10);
    const from = typeof query.from === 'string' && query.from.trim()
      ? query.from.trim()
      : `${date}T00:00:00.000Z`;
    const to = typeof query.to === 'string' && query.to.trim()
      ? query.to.trim()
      : `${date}T23:59:59.999Z`;

    return buildEmailStatsReport(deps.db, { from, to });
  });

  app.post('/api/v1/admin/email/postbox-events', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, deps.emergencyExportToken)) {
      reply.code(401);
      return {
        error: 'unauthorized',
      };
    }

    const body = request.body as unknown;
    const events = Array.isArray(body) ? body : [body];
    const results = events.map((event) => recordPostboxEvent(deps.db, event as Record<string, unknown>));
    return {
      received: events.length,
      results,
    };
  });

}
