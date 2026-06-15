import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

const VK_AUTHORIZE_URL = 'https://id.vk.ru/authorize';
const VK_TOKEN_URL = 'https://id.vk.ru/oauth2/auth';
const VK_USER_INFO_URL = 'https://id.vk.ru/oauth2/user_info';
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type VkAuthDeps = {
  db: Database.Database;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
  allowedReturnOrigins: string[];
};

export type VkAuthSession = {
  token: string;
  provider: string;
  vkUserId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  scope: string | null;
  expiresAt: string;
};

type VkTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  user_id?: string | number;
  error?: string;
  error_description?: string;
};

type VkUserInfoResponse = {
  user?: {
    user_id?: string | number;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    photo_200?: string;
  };
  user_id?: string | number;
  error?: string;
  error_description?: string;
};

function noStore(reply: { header: (name: string, value: string) => unknown }) {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  reply.header('Cache-Control', 'no-store');
}

function base64Url(input: Buffer) {
  return input.toString('base64url');
}

function randomToken(byteLength = 32) {
  return base64Url(crypto.randomBytes(byteLength));
}

function codeChallenge(verifier: string) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function isoAfter(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function isAllowedReturnTo(value: string, allowedOrigins: string[]) {
  try {
    const url = new URL(value);
    const origin = url.origin.replace(/\/+$/u, '');
    return allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

function appendReturnParams(returnTo: string, params: Record<string, string>) {
  const url = new URL(returnTo);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function jsonFromJwtPayload(token: string) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeVkSession(row: {
  token: string;
  provider: string;
  vk_user_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  scope: string | null;
  expires_at: string;
}): VkAuthSession {
  return {
    token: row.token,
    provider: row.provider,
    vkUserId: row.vk_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    scope: row.scope,
    expiresAt: row.expires_at,
  };
}

export function getVkAuthSession(db: Database.Database, token: string | undefined) {
  const normalized = String(token ?? '').trim();
  if (!normalized) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      token,
      provider,
      vk_user_id,
      first_name,
      last_name,
      email,
      phone,
      avatar_url,
      scope,
      expires_at
    FROM vk_auth_sessions
    WHERE token = ?
      AND datetime(expires_at) > datetime('now')
    LIMIT 1
  `).get(normalized) as Parameters<typeof normalizeVkSession>[0] | undefined;

  return row ? normalizeVkSession(row) : null;
}

export async function registerVkAuthApi(app: FastifyInstance, deps: VkAuthDeps) {
  app.get('/api/v1/auth/vk/status', async (_request, reply) => {
    noStore(reply);
    return {
      enabled: Boolean(deps.clientId && deps.clientSecret),
      provider: 'vkid',
      redirectUri: deps.redirectUri,
      scope: deps.scope,
    };
  });

  app.get('/api/v1/auth/vk/start', async (request, reply) => {
    noStore(reply);
    const query = request.query as Record<string, unknown>;
    const returnTo = String(query.returnTo ?? '');
    const safeReturnTo = isAllowedReturnTo(returnTo, deps.allowedReturnOrigins) ? returnTo : '';

    if (!safeReturnTo) {
      reply.code(400);
      return {
        error: 'invalid_return_to',
        message: 'Некорректный адрес возврата после VK ID.',
      };
    }

    if (!deps.clientId || !deps.clientSecret) {
      return reply.redirect(appendReturnParams(safeReturnTo, {
        vk_auth_error: 'not_configured',
      }), 302);
    }

    const state = randomToken(32);
    const verifier = randomToken(64);
    deps.db.prepare(`
      INSERT INTO vk_auth_states(
        state,
        code_verifier,
        return_to,
        expires_at,
        source_ip,
        user_agent
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      state,
      verifier,
      safeReturnTo,
      isoAfter(STATE_TTL_MS),
      request.ip,
      request.headers['user-agent'] ?? null,
    );

    const url = new URL(VK_AUTHORIZE_URL);
    url.searchParams.set('client_id', deps.clientId);
    url.searchParams.set('redirect_uri', deps.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', deps.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'login');

    return reply.redirect(url.toString(), 302);
  });

  app.get('/api/v1/auth/vk/callback', async (request, reply) => {
    noStore(reply);
    const query = request.query as Record<string, unknown>;
    const state = String(query.state ?? '');
    const code = String(query.code ?? '');
    const deviceId = String(query.device_id ?? '');
    const error = stringOrNull(query.error);
    const errorDescription = stringOrNull(query.error_description);
    const stored = deps.db.prepare(`
      SELECT state, code_verifier, return_to, expires_at, used_at
      FROM vk_auth_states
      WHERE state = ?
      LIMIT 1
    `).get(state) as {
      state: string;
      code_verifier: string;
      return_to: string;
      expires_at: string;
      used_at: string | null;
    } | undefined;

    const returnTo = stored?.return_to && isAllowedReturnTo(stored.return_to, deps.allowedReturnOrigins)
      ? stored.return_to
      : deps.allowedReturnOrigins[0] || 'https://kgd80.ru';

    if (!stored || stored.used_at || new Date(stored.expires_at).getTime() <= Date.now()) {
      return reply.redirect(appendReturnParams(returnTo, {
        vk_auth_error: 'state_expired',
      }), 302);
    }

    deps.db.prepare(`
      UPDATE vk_auth_states
      SET used_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE state = ?
    `).run(state);

    if (error || !code) {
      return reply.redirect(appendReturnParams(returnTo, {
        vk_auth_error: error || 'code_missing',
        vk_auth_error_description: errorDescription || '',
      }), 302);
    }

    if (!deps.clientId || !deps.clientSecret) {
      return reply.redirect(appendReturnParams(returnTo, {
        vk_auth_error: 'not_configured',
      }), 302);
    }

    try {
      const tokenParams = new URLSearchParams();
      tokenParams.set('grant_type', 'authorization_code');
      tokenParams.set('code', code);
      tokenParams.set('redirect_uri', deps.redirectUri);
      tokenParams.set('client_id', deps.clientId);
      tokenParams.set('client_secret', deps.clientSecret);
      tokenParams.set('code_verifier', stored.code_verifier);
      if (deviceId) {
        tokenParams.set('device_id', deviceId);
      }

      const tokenResponse = await fetch(VK_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenParams,
      });
      const tokenJson = await tokenResponse.json() as VkTokenResponse;
      if (!tokenResponse.ok || tokenJson.error || !tokenJson.access_token) {
        request.log.warn({
          statusCode: tokenResponse.status,
          error: tokenJson.error,
          errorDescription: tokenJson.error_description,
        }, 'vk_auth_token_exchange_failed');
        return reply.redirect(appendReturnParams(returnTo, {
          vk_auth_error: tokenJson.error || 'token_exchange_failed',
        }), 302);
      }

      const userInfoParams = new URLSearchParams();
      userInfoParams.set('access_token', tokenJson.access_token);
      userInfoParams.set('client_id', deps.clientId);
      const userInfoResponse = await fetch(VK_USER_INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: userInfoParams,
      });
      const userInfo = await userInfoResponse.json() as VkUserInfoResponse;
      if (!userInfoResponse.ok || userInfo.error) {
        request.log.warn({
          statusCode: userInfoResponse.status,
          error: userInfo.error,
          errorDescription: userInfo.error_description,
        }, 'vk_auth_user_info_failed');
        return reply.redirect(appendReturnParams(returnTo, {
          vk_auth_error: userInfo.error || 'user_info_failed',
        }), 302);
      }

      const idTokenClaims = tokenJson.id_token ? jsonFromJwtPayload(tokenJson.id_token) : {};
      const vkUserId = stringOrNull(userInfo.user?.user_id)
        || stringOrNull(userInfo.user_id)
        || stringOrNull(tokenJson.user_id)
        || stringOrNull(idTokenClaims.sub);
      if (!vkUserId) {
        return reply.redirect(appendReturnParams(returnTo, {
          vk_auth_error: 'user_id_missing',
        }), 302);
      }

      const sessionToken = randomToken(32);
      const expiresAt = isoAfter(SESSION_TTL_MS);
      deps.db.prepare(`
        INSERT INTO vk_auth_sessions(
          token,
          provider,
          vk_user_id,
          first_name,
          last_name,
          email,
          phone,
          avatar_url,
          scope,
          expires_at,
          source_ip,
          user_agent
        ) VALUES (?, 'vkid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionToken,
        vkUserId,
        stringOrNull(userInfo.user?.first_name) || stringOrNull(idTokenClaims.given_name),
        stringOrNull(userInfo.user?.last_name) || stringOrNull(idTokenClaims.family_name),
        stringOrNull(userInfo.user?.email) || stringOrNull(idTokenClaims.email),
        stringOrNull(userInfo.user?.phone),
        stringOrNull(userInfo.user?.avatar) || stringOrNull(userInfo.user?.photo_200),
        stringOrNull(tokenJson.scope),
        expiresAt,
        request.ip,
        request.headers['user-agent'] ?? null,
      );

      return reply.redirect(appendReturnParams(returnTo, {
        vk_auth_token: sessionToken,
      }), 302);
    } catch (callbackError) {
      request.log.error({ err: callbackError }, 'vk_auth_callback_failed');
      return reply.redirect(appendReturnParams(returnTo, {
        vk_auth_error: 'server_error',
      }), 302);
    }
  });

  app.get('/api/v1/auth/vk/session/:token', async (request, reply) => {
    noStore(reply);
    const token = (request.params as Record<string, string>).token;
    const session = getVkAuthSession(deps.db, token);
    if (!session) {
      reply.code(404);
      return {
        error: 'vk_auth_session_not_found',
        message: 'Авторизация VK ID устарела или не найдена.',
      };
    }

    return {
      provider: session.provider,
      vkUserId: session.vkUserId,
      firstName: session.firstName,
      lastName: session.lastName,
      fullName: [session.lastName, session.firstName].filter(Boolean).join(' '),
      email: session.email,
      phone: session.phone,
      avatarUrl: session.avatarUrl,
      expiresAt: session.expiresAt,
    };
  });
}
