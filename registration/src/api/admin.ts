import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { createSqliteBackup } from '../services/admin-maintenance';
import { buildRegistrationsXlsxBuffer, listAllRegistrationsForExport } from '../services/registration-exports';
import { buildVkSocialDailyReport, getVkSocialReport } from '../services/vk-social-monitoring';

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
}
