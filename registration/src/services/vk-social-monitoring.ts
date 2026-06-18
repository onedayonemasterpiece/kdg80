import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { Bot, Context } from 'grammy';
import { decryptPii } from '../lib/crypto';
import { LlmProviderError, runLlmLimited } from '../lib/llm-rate-limiter';
import { listTelegramAdmins } from './telegram-admins';

const VK_API_BASE_URL = 'https://api.vk.com/method/';
const VK_API_VERSION = process.env.VK_API_VERSION?.trim() || '5.199';
const DEFAULT_GROUPS = [
  { screenName: 'klgdevents', groupId: 231920894 },
  { screenName: 'kenigeventsofficial', groupId: 231828790 },
] as const;
const SCHEDULE_HOURS = [9, 21];
const DEFAULT_TIME_ZONE = 'Europe/Kaliningrad';

export type VkSocialAction =
  | 'like_post'
  | 'comment_post'
  | 'reply_comment'
  | 'like_comment'
  | 'repost_post'
  | 'like_video';

export type VkSocialActor = {
  vkUserId: number;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  isClosed: boolean | null;
  actions: Set<VkSocialAction>;
  activityCount: number;
  lastSeenAt: string | null;
};

export type VkSocialActivity = {
  activityKey: string;
  source: 'notifications' | 'wall_scan' | 'wall_scan_copies' | 'user_wall';
  action: VkSocialAction;
  vkUserId: number;
  groupId: number | null;
  postId: number | null;
  commentId: number | null;
  activityDate: string | null;
  payload: Record<string, unknown>;
};

export type SpecialApplicant = {
  id: number;
  applicationCode: string;
  status: string;
  fullName: string;
  tokens: string[];
};

export type MatchStatus = 'matched' | 'weak' | 'ambiguous' | 'unmatched';
type MatchMethod = 'deterministic' | 'llm' | 'none';
type VkSocialReportMode = 'delta' | 'rolling';

export type MatchVerdict = {
  status: MatchStatus;
  method: MatchMethod;
  confidence: number;
  matchedSpecialApplicationId: number | null;
  candidateCount: number;
  reason: string;
  llmModel: string | null;
};

type Candidate = {
  applicant: SpecialApplicant;
  score: number;
  reason: string;
  exactSurnameGiven: boolean;
};

type VkSocialRunDeps = {
  db: Database.Database;
  token: string;
  privateKeyPemBase64: string;
  logger?: FastifyBaseLogger;
  dryRun?: boolean;
  trigger?: 'scheduled' | 'manual' | 'dry_run';
  runKey?: string;
  bot?: Bot<Context>;
  sendTelegramReport?: boolean;
  reportHours?: number;
};

type VkSocialRunResult = {
  runKey: string;
  dryRun: boolean;
  notificationsCount: number;
  wallPostCount: number;
  activityCount: number;
  actorCount: number;
  matchedCount: number;
  weakCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  llmRequestCount: number;
  sourceSummary: Record<string, unknown>;
  telegramReportSent: boolean;
  actors: Array<{
    vkUserId: number;
    displayName: string;
    actions: string[];
    activityCount: number;
    match: MatchVerdict;
  }>;
};

type VkSocialReportInterval = {
  mode: VkSocialReportMode;
  sinceIso: string;
  untilIso: string;
  sinceExclusive: boolean;
  hours: number;
  source: 'rolling_hours' | 'previous_sent_report' | 'previous_completed_run' | 'fallback_hours';
  currentRunId: number | null;
  previousReportId: number | null;
  previousRunId: number | null;
};

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isoFromUnix(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return new Date(numeric * 1000).toISOString();
}

function safeString(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizePostText(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^a-zа-я0-9:.\/\s-]+/giu, ' ')
    .replace(/-/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractPostSearchText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  const parts = [safeString(row.text) ?? ''];
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  for (const rawAttachment of attachments) {
    if (!rawAttachment || typeof rawAttachment !== 'object') continue;
    const attachment = rawAttachment as Record<string, unknown>;
    for (const key of ['link', 'video', 'photo', 'event']) {
      const nested = attachment[key];
      if (nested && typeof nested === 'object') {
        const nestedRow = nested as Record<string, unknown>;
        parts.push(
          safeString(nestedRow.title) ?? '',
          safeString(nestedRow.description) ?? '',
          safeString(nestedRow.text) ?? '',
        );
      }
    }
  }
  return parts.filter(Boolean).join(' ');
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^a-zа-я\s-]+/giu, ' ')
    .replace(/-/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function nameTokens(value: string) {
  return normalizeName(value).split(' ').filter(Boolean);
}

type FutureEventSignature = {
  title: string;
  startsAt: string;
  aliases: string[];
  titleTokens: string[];
};

const RUSSIAN_MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const TITLE_STOP_WORDS = new Set([
  'фестиваль',
  'знание',
  'кино',
  'показ',
  'спецпоказ',
  'регистрация',
  'калининград',
  'южный',
  'вокзал',
]);

function localDateParts(date: Date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    day: Number(get('day')),
    month: Number(get('month')),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function buildDateAliases(startsAt: string) {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return [];
  const parts = localDateParts(date);
  const day = String(parts.day);
  const paddedDay = day.padStart(2, '0');
  const paddedMonth = String(parts.month).padStart(2, '0');
  const monthName = RUSSIAN_MONTHS_GENITIVE[parts.month - 1] ?? '';
  return [
    `${day} ${monthName}`,
    `${paddedDay} ${monthName}`,
    `${paddedDay}.${paddedMonth}`,
    `${day}.${paddedMonth}`,
    `${paddedDay}/${paddedMonth}`,
    `${day}/${paddedMonth}`,
    `${day} ${monthName} ${parts.hour}:${parts.minute}`,
  ].filter(Boolean).map(normalizePostText);
}

function buildTitleTokens(title: string) {
  return nameTokens(title)
    .filter((token) => token.length >= 5 && !TITLE_STOP_WORDS.has(token))
    .slice(0, 6);
}

function loadFutureEventSignatures(db: Database.Database, now = new Date()): FutureEventSignature[] {
  const rows = db.prepare(`
    SELECT title, starts_at AS startsAt
    FROM events
    UNION ALL
    SELECT e.title || ' ' || s.display_label AS title, s.starts_at AS startsAt
    FROM special_event_showings s
    INNER JOIN special_events e ON e.id = s.special_event_id
  `).all() as Array<{ title: string; startsAt: string }>;
  return rows
    .filter((row) => new Date(row.startsAt).getTime() > now.getTime())
    .map((row) => ({
      title: row.title,
      startsAt: row.startsAt,
      aliases: buildDateAliases(row.startsAt),
      titleTokens: buildTitleTokens(row.title),
    }))
    .filter((row) => row.aliases.length || row.titleTokens.length);
}

function isFutureEventPost(post: unknown, signatures: FutureEventSignature[]) {
  if (!signatures.length) return false;
  const normalized = normalizePostText(extractPostSearchText(post));
  if (!normalized) return false;
  return signatures.some((signature) => {
    if (signature.aliases.some((alias) => alias && normalized.includes(alias))) return true;
    const requiredMatches = Math.min(2, signature.titleTokens.length);
    if (requiredMatches <= 0) return false;
    const matches = signature.titleTokens.filter((token) => normalized.includes(token)).length;
    return matches >= requiredMatches;
  });
}

function levenshtein(left: string, right: string) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let row = 0; row < rows; row += 1) dp[row][0] = row;
  for (let col = 0; col < cols; col += 1) dp[0][col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      dp[row][col] = Math.min(
        dp[row - 1][col] + 1,
        dp[row][col - 1] + 1,
        dp[row - 1][col - 1] + (left[row - 1] === right[col - 1] ? 0 : 1),
      );
    }
  }
  return dp[left.length][right.length];
}

function tokenMatchScore(left: string, right: string) {
  if (left === right) return 1;
  if (left.length >= 5 && right.length >= 5 && levenshtein(left, right) <= 1) return 0.92;
  if (
    (left.length >= 5 && right.startsWith(left.slice(0, 5)))
    || (right.length >= 5 && left.startsWith(right.slice(0, 5)))
  ) {
    return 0.84;
  }
  return 0;
}

function isOrganizationLikeName(displayName: string) {
  return /калининград|афиша|анонсы|полюбить|event|events|official|club/iu.test(normalizeName(displayName));
}

function scoreVkAgainstApplicant(vkFirst: string, vkLast: string, applicant: SpecialApplicant): Candidate | null {
  const first = nameTokens(vkFirst)[0] || '';
  const last = nameTokens(vkLast)[0] || '';
  if (!first || !last || applicant.tokens.length < 2) {
    return null;
  }

  const tokens = applicant.tokens;
  const exactSurnameGiven = (
    tokens[0] === last && tokens[1] === first
  ) || (
    tokens.length === 2 && tokens.includes(first) && tokens.includes(last)
  );

  if (exactSurnameGiven) {
    return {
      applicant,
      score: 1,
      reason: 'vk_first_last_matches_application_surname_given_name',
      exactSurnameGiven: true,
    };
  }

  const forward = Math.max(
    tokenMatchScore(first, tokens[0]) + tokenMatchScore(last, tokens[1]),
    tokenMatchScore(first, tokens[1] ?? '') + tokenMatchScore(last, tokens[0]),
  ) / 2;
  let bestAnyPair = 0;
  for (const left of [first, last]) {
    let best = 0;
    for (const token of tokens) {
      best = Math.max(best, tokenMatchScore(left, token));
    }
    bestAnyPair += best / 2;
  }
  const score = Math.max(forward, bestAnyPair);
  if (score < 0.84) {
    return null;
  }

  return {
    applicant,
    score,
    reason: 'vk_name_approximately_matches_application_tokens',
    exactSurnameGiven: false,
  };
}

export function deterministicMatchActor(
  actor: Pick<VkSocialActor, 'firstName' | 'lastName' | 'displayName'>,
  applicants: SpecialApplicant[],
): { verdict: MatchVerdict; candidates: Candidate[] } {
  if (isOrganizationLikeName(actor.displayName)) {
    return {
      verdict: {
        status: 'unmatched',
        method: 'deterministic',
        confidence: 0,
        matchedSpecialApplicationId: null,
        candidateCount: 0,
        reason: 'vk_display_name_looks_like_organization',
        llmModel: null,
      },
      candidates: [],
    };
  }

  const first = actor.firstName ?? '';
  const last = actor.lastName ?? '';
  const candidates = applicants
    .map((applicant) => scoreVkAgainstApplicant(first, last, applicant))
    .filter((item): item is Candidate => Boolean(item))
    .sort((left, right) => right.score - left.score);
  const top = candidates[0];
  const runner = candidates[1];
  if (!top) {
    return {
      verdict: {
        status: 'unmatched',
        method: 'deterministic',
        confidence: 0,
        matchedSpecialApplicationId: null,
        candidateCount: 0,
        reason: 'no_name_candidate',
        llmModel: null,
      },
      candidates,
    };
  }

  const runnerScore = runner?.score ?? 0;
  if (top.exactSurnameGiven && (!runner || runner.score < 0.99)) {
    return {
      verdict: {
        status: 'matched',
        method: 'deterministic',
        confidence: 1,
        matchedSpecialApplicationId: top.applicant.id,
        candidateCount: candidates.length,
        reason: top.reason,
        llmModel: null,
      },
      candidates,
    };
  }

  const status: MatchStatus = top.score >= 0.84 && top.score - runnerScore >= 0.08 ? 'weak' : 'ambiguous';
  return {
    verdict: {
      status,
      method: 'deterministic',
      confidence: Number(top.score.toFixed(2)),
      matchedSpecialApplicationId: status === 'weak' ? top.applicant.id : null,
      candidateCount: candidates.length,
      reason: runner ? `${top.reason}; runner_up=${runner.score.toFixed(2)}` : top.reason,
      llmModel: null,
    },
    candidates,
  };
}

class VkApiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class VkApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`VK API ${method} failed: ${code} ${message}`);
  }
}

function isIgnorableWallObjectError(error: unknown) {
  return error instanceof VkApiError && [15, 30, 100, 203].includes(error.code);
}

class VkApiClient {
  private lastStartedAt = 0;

  constructor(private readonly token: string) {}

  async call<T extends Record<string, unknown>>(method: string, params: Record<string, string | number | undefined>) {
    const minIntervalMs = readPositiveInteger(process.env.VK_SOCIAL_API_MIN_INTERVAL_MS, 1_100);
    const jitterMs = readPositiveInteger(process.env.VK_SOCIAL_API_JITTER_MS, 700);
    const maxRetries = readPositiveInteger(process.env.VK_SOCIAL_API_MAX_RETRIES, 4);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const plannedIntervalMs = minIntervalMs + crypto.randomInt(jitterMs + 1);
      const waitMs = Math.max(0, this.lastStartedAt + plannedIntervalMs - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.lastStartedAt = Date.now();

      try {
        const body = new URLSearchParams();
        body.set('access_token', this.token);
        body.set('v', VK_API_VERSION);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) body.set(key, String(value));
        }
        const response = await fetch(`${VK_API_BASE_URL}${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(readPositiveInteger(process.env.VK_SOCIAL_API_TIMEOUT_MS, 25_000)),
        });
        const json = await response.json() as { response?: T; error?: { error_code: number; error_msg: string } };
        if (json.error) {
          if (json.error.error_code === 6) {
            throw new VkApiRateLimitError(json.error.error_msg);
          }
          throw new VkApiError(method, json.error.error_code, json.error.error_msg);
        }
        return json.response as T;
      } catch (error) {
        lastError = error;
        if (!(error instanceof VkApiRateLimitError) || attempt >= maxRetries) {
          break;
        }
        await sleep(Math.min(1_500 * (attempt + 1), 8_000));
      }
    }
    throw lastError;
  }
}

function getProfileMap(response: { profiles?: unknown }) {
  const profiles = Array.isArray(response.profiles) ? response.profiles : [];
  const map = new Map<number, Record<string, unknown>>();
  for (const profile of profiles) {
    if (profile && typeof profile === 'object') {
      const row = profile as Record<string, unknown>;
      const id = Number(row.id);
      if (Number.isFinite(id)) map.set(id, row);
    }
  }
  return map;
}

function addActor(
  actors: Map<number, VkSocialActor>,
  vkUserId: number,
  profile: Record<string, unknown> | undefined,
  action: VkSocialAction,
  activityDate: string | null,
) {
  if (!Number.isFinite(vkUserId) || vkUserId <= 0) return null;
  const firstName = safeString(profile?.first_name);
  const lastName = safeString(profile?.last_name);
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || `id${vkUserId}`;
  const current = actors.get(vkUserId) ?? {
    vkUserId,
    firstName,
    lastName,
    displayName,
    isClosed: typeof profile?.is_closed === 'boolean' ? profile.is_closed : null,
    actions: new Set<VkSocialAction>(),
    activityCount: 0,
    lastSeenAt: null,
  };
  current.firstName = current.firstName || firstName;
  current.lastName = current.lastName || lastName;
  current.displayName = [current.firstName, current.lastName].filter(Boolean).join(' ') || displayName;
  current.isClosed = typeof profile?.is_closed === 'boolean' ? profile.is_closed : current.isClosed;
  current.actions.add(action);
  current.activityCount += 1;
  if (activityDate && (!current.lastSeenAt || activityDate > current.lastSeenAt)) {
    current.lastSeenAt = activityDate;
  }
  actors.set(vkUserId, current);
  return current;
}

export function buildActivityKey(input: {
  action: VkSocialAction;
  vkUserId: number;
  groupId: number | null;
  postId: number | null;
  commentId: number | null;
}) {
  return [
    input.action,
    input.vkUserId,
    input.groupId ?? 0,
    input.postId ?? 0,
    input.commentId ?? 0,
  ].join(':');
}

function addActivity(
  activities: Map<string, VkSocialActivity>,
  actors: Map<number, VkSocialActor>,
  input: Omit<VkSocialActivity, 'activityKey'>,
  profile?: Record<string, unknown>,
) {
  if (!Number.isFinite(input.vkUserId) || input.vkUserId <= 0) return;
  addActor(actors, input.vkUserId, profile, input.action, input.activityDate);
  const activityKey = buildActivityKey(input);
  if (!activities.has(activityKey)) {
    activities.set(activityKey, {
      activityKey,
      ...input,
    });
  }
}

function actionFromNotificationType(type: string): VkSocialAction | null {
  if (type === 'like_post') return 'like_post';
  if (type === 'like_comment') return 'like_comment';
  if (type === 'reply_comment') return 'reply_comment';
  if (type === 'comment_post' || type === 'wall') return 'comment_post';
  if (type === 'copy_post' || type === 'repost_post') return 'repost_post';
  if (type === 'like_video') return 'like_video';
  return null;
}

export function parseNotificationActivities(
  response: Record<string, unknown>,
  actors: Map<number, VkSocialActor> = new Map(),
  activities: Map<string, VkSocialActivity> = new Map(),
  futureSignatures: FutureEventSignature[] = [],
) {
  const profiles = getProfileMap(response);
  const items = Array.isArray(response.items) ? response.items : [];
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    const action = actionFromNotificationType(String(item.type ?? ''));
    if (!action) continue;
    const activityDate = isoFromUnix(item.date);
    const feedback = item.feedback && typeof item.feedback === 'object'
      ? item.feedback as Record<string, unknown>
      : {};
    const parent = item.parent && typeof item.parent === 'object'
      ? item.parent as Record<string, unknown>
      : {};
    const parentPost = parent.post && typeof parent.post === 'object'
      ? parent.post as Record<string, unknown>
      : {};
    if ((action === 'like_post' || action === 'repost_post') && futureSignatures.length) {
      const postForClassification = Object.keys(parentPost).length ? parentPost : parent;
      const hasClassifiableText = extractPostSearchText(postForClassification).trim().length > 0;
      if (hasClassifiableText && !isFutureEventPost(postForClassification, futureSignatures)) {
        continue;
      }
    }
    const ownerId = Number(parent.owner_id ?? feedback.owner_id ?? parentPost.owner_id);
    const groupId = Number.isFinite(ownerId) && ownerId < 0 ? Math.abs(ownerId) : null;
    const postId = Number(parent.post_id ?? parentPost.id ?? parent.id);
    const commentId = action === 'like_comment' || action === 'reply_comment'
      ? Number(parent.id ?? feedback.id)
      : Number(feedback.id);
    const add = (vkUserId: number) => {
      addActivity(activities, actors, {
        source: 'notifications',
        action,
        vkUserId,
        groupId,
        postId: Number.isFinite(postId) ? postId : null,
        commentId: Number.isFinite(commentId) ? commentId : null,
        activityDate,
        payload: { notificationType: item.type },
      }, profiles.get(vkUserId));
    };
    const directFromId = Number(feedback.from_id);
    if (Number.isFinite(directFromId)) add(directFromId);
    const feedbackItems = Array.isArray(feedback.items) ? feedback.items : [];
    for (const rawFeedbackItem of feedbackItems) {
      if (rawFeedbackItem && typeof rawFeedbackItem === 'object') {
        const fromId = Number((rawFeedbackItem as Record<string, unknown>).from_id);
        if (Number.isFinite(fromId)) add(fromId);
      }
    }
  }
  return { actors, activities };
}

async function collectNotifications(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  futureSignatures: FutureEventSignature[],
) {
  const maxPages = readPositiveInteger(process.env.VK_SOCIAL_NOTIFICATIONS_MAX_PAGES, 8);
  let startFrom: string | undefined;
  let count = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.call<Record<string, unknown>>('notifications.get', {
      count: 50,
      filters: 'wall,mentions,comments,likes,reposts',
      start_from: startFrom,
    });
    const items = Array.isArray(response.items) ? response.items : [];
    count += items.length;
    parseNotificationActivities(response, actors, activities, futureSignatures);
    startFrom = safeString(response.next_from) ?? undefined;
    if (!startFrom) break;
  }
  return count;
}

async function collectWallBackfill(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  futureSignatures: FutureEventSignature[],
) {
  const pageSize = Math.min(readPositiveInteger(process.env.VK_SOCIAL_WALL_PAGE_SIZE, 100), 100);
  const maxPages = readPositiveInteger(process.env.VK_SOCIAL_WALL_MAX_PAGES, 5);
  const lookbackDays = Math.min(readPositiveInteger(process.env.VK_SOCIAL_WALL_LOOKBACK_DAYS, 5), 5);
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  let scannedPosts = 0;
  for (const group of DEFAULT_GROUPS) {
    for (let page = 0; page < maxPages; page += 1) {
      const wall = await client.call<{ items?: unknown[] }>('wall.get', {
        owner_id: -group.groupId,
        filter: 'owner',
        count: pageSize,
        offset: page * pageSize,
      });
      const posts = Array.isArray(wall.items) ? wall.items : [];
      scannedPosts += posts.length;
      let reachedOldPosts = false;
      for (const rawPost of posts) {
        if (!rawPost || typeof rawPost !== 'object') continue;
        const post = rawPost as Record<string, unknown>;
        const postId = Number(post.id);
        if (!Number.isFinite(postId)) continue;
        const postDate = isoFromUnix(post.date);
        if (postDate && new Date(postDate).getTime() < cutoffMs) {
          reachedOldPosts = true;
          continue;
        }
        const isFuture = isFutureEventPost(post, futureSignatures);
        const likesCount = Number((post.likes as Record<string, unknown> | undefined)?.count ?? 0);
        const commentsCount = Number((post.comments as Record<string, unknown> | undefined)?.count ?? 0);
        const repostsCount = Number((post.reposts as Record<string, unknown> | undefined)?.count ?? 0);
        if (likesCount > 0 && isFuture) {
          try {
            await collectPostLikes(client, actors, activities, group.groupId, postId);
          } catch (error) {
            if (!isIgnorableWallObjectError(error)) throw error;
          }
        }
        if (commentsCount > 0) {
          try {
            await collectPostComments(client, actors, activities, group.groupId, postId);
          } catch (error) {
            if (!isIgnorableWallObjectError(error)) throw error;
          }
        }
        if (repostsCount > 0 && isFuture) {
          try {
            await collectPostReposts(client, actors, activities, group.groupId, postId);
          } catch (error) {
            if (!isIgnorableWallObjectError(error)) throw error;
          }
        }
      }
      if (posts.length < pageSize || reachedOldPosts) break;
    }
  }
  return scannedPosts;
}

async function collectPostLikes(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  groupId: number,
  postId: number,
) {
  const response = await client.call<{ items?: unknown[]; profiles?: unknown[] }>('likes.getList', {
    type: 'post',
    owner_id: -groupId,
    item_id: postId,
    extended: 1,
    count: 1_000,
  });
  const profiles = getProfileMap(response);
  for (const rawItem of Array.isArray(response.items) ? response.items : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as Record<string, unknown> : null;
    const vkUserId = Number(item?.id ?? rawItem);
    if (Number.isFinite(vkUserId)) {
      addActivity(activities, actors, {
        source: 'wall_scan',
        action: 'like_post',
        vkUserId,
        groupId,
        postId,
        commentId: null,
        activityDate: null,
        payload: { activityDatePrecision: 'unknown_from_likes_getList' },
      }, item ?? profiles.get(vkUserId));
    }
  }
}

async function collectPostComments(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  groupId: number,
  postId: number,
) {
  const response = await client.call<{ items?: unknown[]; profiles?: unknown[] }>('wall.getComments', {
    owner_id: -groupId,
    post_id: postId,
    extended: 1,
    count: 100,
    sort: 'asc',
  });
  const profiles = getProfileMap(response);
  for (const rawItem of Array.isArray(response.items) ? response.items : []) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    const vkUserId = Number(item.from_id);
    if (Number.isFinite(vkUserId) && vkUserId > 0) {
      addActivity(activities, actors, {
        source: 'wall_scan',
        action: 'comment_post',
        vkUserId,
        groupId,
        postId,
        commentId: Number.isFinite(Number(item.id)) ? Number(item.id) : null,
        activityDate: isoFromUnix(item.date),
        payload: {},
      }, profiles.get(vkUserId));
    }
  }
}

async function collectPostReposts(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  groupId: number,
  postId: number,
) {
  const response = await client.call<{ items?: unknown[]; profiles?: unknown[] }>('likes.getList', {
    type: 'post',
    owner_id: -groupId,
    item_id: postId,
    filter: 'copies',
    extended: 1,
    count: 1_000,
  });
  const profiles = getProfileMap(response);
  for (const rawItem of Array.isArray(response.items) ? response.items : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as Record<string, unknown> : null;
    const vkUserId = Number(item?.id ?? rawItem);
    if (Number.isFinite(vkUserId)) {
      addActivity(activities, actors, {
        source: 'wall_scan_copies',
        action: 'repost_post',
        vkUserId,
        groupId,
        postId,
        commentId: null,
        activityDate: null,
        payload: { activityDatePrecision: 'unknown_from_likes_getList_copies' },
      }, item ?? profiles.get(vkUserId));
    }
  }
}

function findTargetGroupCopies(post: unknown, futureSignatures: FutureEventSignature[], out: Array<{
  groupId: number;
  originalPostId: number;
  originalUrl: string;
}> = []) {
  if (!post || typeof post !== 'object') return out;
  const row = post as Record<string, unknown>;
  const copies = Array.isArray(row.copy_history) ? row.copy_history : [];
  for (const rawCopy of copies) {
    if (!rawCopy || typeof rawCopy !== 'object') continue;
    const copy = rawCopy as Record<string, unknown>;
    const ownerId = Number(copy.owner_id);
    const groupId = ownerId < 0 ? Math.abs(ownerId) : null;
    const originalPostId = Number(copy.id);
    if (groupId && DEFAULT_GROUPS.some((group) => group.groupId === groupId) && Number.isFinite(originalPostId)) {
      if (isFutureEventPost(copy, futureSignatures)) {
        out.push({
          groupId,
          originalPostId,
          originalUrl: `https://vk.com/wall-${groupId}_${originalPostId}`,
        });
      }
    }
    findTargetGroupCopies(copy, futureSignatures, out);
  }
  return out;
}

async function collectMatchedUserWallReposts(
  client: VkApiClient,
  actors: Map<number, VkSocialActor>,
  activities: Map<string, VkSocialActivity>,
  matches: Map<number, MatchVerdict>,
  futureSignatures: FutureEventSignature[],
) {
  const pageSize = Math.min(readPositiveInteger(process.env.VK_SOCIAL_USER_WALL_PAGE_SIZE, 100), 100);
  const maxPages = readPositiveInteger(process.env.VK_SOCIAL_USER_WALL_MAX_PAGES, 5);
  const lookbackDays = Math.min(readPositiveInteger(process.env.VK_SOCIAL_USER_WALL_LOOKBACK_DAYS, 5), 5);
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  let scannedUserWallPosts = 0;
  let userWallRepostCount = 0;
  const targetActors = [...actors.values()].filter((actor) => {
    const match = matches.get(actor.vkUserId);
    return match?.matchedSpecialApplicationId && (match.status === 'matched' || match.status === 'weak');
  });

  for (const actor of targetActors) {
    for (let page = 0; page < maxPages; page += 1) {
      let wall: { items?: unknown[] };
      try {
        wall = await client.call<{ items?: unknown[] }>('wall.get', {
          owner_id: actor.vkUserId,
          filter: 'owner',
          count: pageSize,
          offset: page * pageSize,
        });
      } catch (error) {
        if (isIgnorableWallObjectError(error)) break;
        throw error;
      }
      const posts = Array.isArray(wall.items) ? wall.items : [];
      scannedUserWallPosts += posts.length;
      let reachedOldPosts = false;
      for (const rawPost of posts) {
        if (!rawPost || typeof rawPost !== 'object') continue;
        const post = rawPost as Record<string, unknown>;
        const wallPostId = Number(post.id);
        const activityDate = isoFromUnix(post.date);
        if (activityDate && new Date(activityDate).getTime() < cutoffMs) {
          reachedOldPosts = true;
          continue;
        }
        if (!Number.isFinite(wallPostId) || !activityDate) continue;
        const copies = findTargetGroupCopies(post, futureSignatures);
        for (const copy of copies) {
          addActivity(activities, actors, {
            source: 'user_wall',
            action: 'repost_post',
            vkUserId: actor.vkUserId,
            groupId: copy.groupId,
            postId: copy.originalPostId,
            commentId: wallPostId,
            activityDate,
            payload: {
              activityDatePrecision: 'user_wall_post_date',
              userWallUrl: `https://vk.com/wall${actor.vkUserId}_${wallPostId}`,
              originalUrl: copy.originalUrl,
            },
          });
          userWallRepostCount += 1;
        }
      }
      if (posts.length < pageSize || reachedOldPosts) break;
    }
  }

  return {
    scannedUserWallPosts,
    userWallRepostCount,
  };
}

function loadSpecialApplicants(db: Database.Database, privateKeyPemBase64: string) {
  const rows = db.prepare(`
    SELECT id, application_code, status, pii_ciphertext, pii_wrapped_key, pii_iv, pii_alg
    FROM special_applications
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    application_code: string;
    status: string;
    pii_ciphertext: Buffer;
    pii_wrapped_key: Buffer;
    pii_iv: Buffer;
    pii_alg: string;
  }>;

  return rows.map((row) => {
    const pii = decryptPii(privateKeyPemBase64, {
      piiCiphertext: row.pii_ciphertext,
      piiWrappedKey: row.pii_wrapped_key,
      piiIv: row.pii_iv,
      piiAlg: row.pii_alg,
    });
    const fullName = String(pii.fullName ?? '');
    return {
      id: row.id,
      applicationCode: row.application_code,
      status: row.status,
      fullName,
      tokens: nameTokens(fullName),
    };
  });
}

function getCachedMatch(db: Database.Database, actor: VkSocialActor) {
  const row = db.prepare(`
    SELECT status, method, confidence, matched_special_application_id, candidate_count, reason, llm_model
    FROM vk_social_match_cache
    WHERE vk_user_id = ? AND vk_display_name = ?
    LIMIT 1
  `).get(actor.vkUserId, actor.displayName) as {
    status: MatchStatus;
    method: MatchMethod;
    confidence: number;
    matched_special_application_id: number | null;
    candidate_count: number;
    reason: string | null;
    llm_model: string | null;
  } | undefined;

  return row ? {
    status: row.status,
    method: row.method,
    confidence: row.confidence,
    matchedSpecialApplicationId: row.matched_special_application_id,
    candidateCount: row.candidate_count,
    reason: row.reason ?? '',
    llmModel: row.llm_model,
  } satisfies MatchVerdict : null;
}

function saveMatchCache(db: Database.Database, actor: VkSocialActor, verdict: MatchVerdict) {
  db.prepare(`
    INSERT INTO vk_social_match_cache(
      vk_user_id,
      vk_display_name,
      status,
      method,
      confidence,
      matched_special_application_id,
      candidate_count,
      reason,
      llm_model,
      checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(vk_user_id, vk_display_name) DO UPDATE SET
      status = excluded.status,
      method = excluded.method,
      confidence = excluded.confidence,
      matched_special_application_id = excluded.matched_special_application_id,
      candidate_count = excluded.candidate_count,
      reason = excluded.reason,
      llm_model = excluded.llm_model,
      checked_at = excluded.checked_at
  `).run(
    actor.vkUserId,
    actor.displayName,
    verdict.status,
    verdict.method,
    verdict.confidence,
    verdict.matchedSpecialApplicationId,
    verdict.candidateCount,
    verdict.reason.slice(0, 500),
    verdict.llmModel,
  );
}

function parseJsonFromText(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  return JSON.parse(match ? match[1] : trimmed) as unknown;
}

async function runLlmMatchBatch(input: Array<{
  actor: VkSocialActor;
  candidates: Candidate[];
}>): Promise<{ matches: Map<number, MatchVerdict>; called: boolean }> {
  const token = process.env.FOUR_O_TOKEN?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!token || process.env.SOCIAL_MATCH_LLM_ENABLED === '0') {
    return { matches: new Map<number, MatchVerdict>(), called: false };
  }
  const model = process.env.SOCIAL_MATCH_LLM_MODEL?.trim() || 'gemma-4';
  const url = process.env.SOCIAL_MATCH_LLM_URL?.trim()
    || process.env.FOUR_O_URL?.trim()
    || 'https://api.openai.com/v1/chat/completions';
  const payload = input.map((item) => ({
    vkUserId: item.actor.vkUserId,
    vkName: item.actor.displayName,
    candidates: item.candidates.slice(0, 5).map((candidate) => ({
      applicationId: candidate.applicant.id,
      fullName: candidate.applicant.fullName,
      deterministicScore: Number(candidate.score.toFixed(2)),
    })),
  }));
  const limited = await runLlmLimited(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(readPositiveInteger(process.env.SOCIAL_MATCH_LLM_TIMEOUT_MS, 120_000)),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: [
              'Ты сверяешь имя VK-профиля с ФИО заявки на мероприятие.',
              'Верни только JSON-массив без markdown.',
              'decision: matched, weak, ambiguous или unmatched.',
              'matched допускается только если почти наверняка это один человек.',
              'weak если похоже, но есть риск псевдонима, отчества вместо фамилии или опечатки.',
              'ambiguous если несколько кандидатов похожи.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({ items: payload }),
          },
        ],
      }),
    });
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new LlmProviderError(json.error?.message || 'Social matching LLM failed', response.status, null);
    }
    const content = json.choices?.[0]?.message?.content ?? '[]';
    return parseJsonFromText(content);
  }, {
    consumer: 'vk-social-match',
    provider: 'openai-compatible',
    model,
    minIntervalMs: readPositiveInteger(process.env.SOCIAL_MATCH_LLM_MIN_INTERVAL_MS, 5_000),
    maxRetries: readPositiveInteger(process.env.SOCIAL_MATCH_LLM_MAX_RETRIES, 2),
  });

  const rows = Array.isArray(limited.value) ? limited.value : [];
  const out = new Map<number, MatchVerdict>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const vkUserId = Number(row.vkUserId);
    const status = String(row.decision || row.status);
    if (!Number.isFinite(vkUserId) || !['matched', 'weak', 'ambiguous', 'unmatched'].includes(status)) {
      continue;
    }
    const applicationId = Number(row.applicationId);
    out.set(vkUserId, {
      status: status as MatchStatus,
      method: 'llm',
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0))),
      matchedSpecialApplicationId: Number.isFinite(applicationId) && ['matched', 'weak'].includes(status)
        ? applicationId
        : null,
      candidateCount: 0,
      reason: safeString(row.reason) || 'llm_verdict',
      llmModel: model,
    });
  }
  return { matches: out, called: true };
}

async function matchActors(
  db: Database.Database,
  actors: VkSocialActor[],
  applicants: SpecialApplicant[],
  dryRun: boolean,
) {
  const results = new Map<number, MatchVerdict>();
  const fallback: Array<{ actor: VkSocialActor; candidates: Candidate[] }> = [];
  for (const actor of actors) {
    const cached = dryRun ? null : getCachedMatch(db, actor);
    if (cached) {
      results.set(actor.vkUserId, cached);
      continue;
    }
    const deterministic = deterministicMatchActor(actor, applicants);
    if (deterministic.verdict.status === 'matched' || deterministic.verdict.status === 'unmatched') {
      results.set(actor.vkUserId, deterministic.verdict);
      if (!dryRun) saveMatchCache(db, actor, deterministic.verdict);
      continue;
    }
    fallback.push({ actor, candidates: deterministic.candidates });
    results.set(actor.vkUserId, deterministic.verdict);
  }

  const batchSize = readPositiveInteger(process.env.SOCIAL_MATCH_LLM_BATCH_SIZE, 12);
  let llmRequestCount = 0;
  for (let index = 0; index < fallback.length; index += batchSize) {
    const batch = fallback.slice(index, index + batchSize);
    try {
      const llm = await runLlmMatchBatch(batch);
      if (llm.called) llmRequestCount += 1;
      for (const item of batch) {
        const verdict = llm.matches.get(item.actor.vkUserId);
        if (verdict) {
          verdict.candidateCount = item.candidates.length;
          results.set(item.actor.vkUserId, verdict);
          if (!dryRun) saveMatchCache(db, item.actor, verdict);
        } else if (!dryRun) {
          saveMatchCache(db, item.actor, results.get(item.actor.vkUserId)!);
        }
      }
    } catch {
      for (const item of batch) {
        if (!dryRun) saveMatchCache(db, item.actor, results.get(item.actor.vkUserId)!);
      }
    }
  }
  return { results, llmRequestCount };
}

function countByStatus(matches: Map<number, MatchVerdict>, status: MatchStatus) {
  return [...matches.values()].filter((item) => item.status === status).length;
}

function createRunKey(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}${String(date.getUTCMinutes()).padStart(2, '0')}-${crypto.randomUUID()}`;
}

export function getDueVkSocialRunKey(db: Database.Database, date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const hour = Number(get('hour') || '0');
  const minute = Number(get('minute') || '0');
  const dueHour = [...SCHEDULE_HOURS].reverse().find((candidate) => hour > candidate || (hour === candidate && minute >= 0));
  if (dueHour === undefined) return null;
  const runKey = `${get('year')}-${get('month')}-${get('day')}-${String(dueHour).padStart(2, '0')}`;
  const existing = db.prepare('SELECT status FROM vk_social_runs WHERE run_key = ? LIMIT 1').get(runKey) as { status: string } | undefined;
  return existing ? null : runKey;
}

function persistRun(
  db: Database.Database,
  runId: number,
  result: Omit<VkSocialRunResult, 'actors'>,
  status: 'completed' | 'failed',
  error: string | null = null,
) {
  db.prepare(`
    UPDATE vk_social_runs
    SET status = ?,
        finished_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        error = ?,
        notifications_count = ?,
        wall_post_count = ?,
        activity_count = ?,
        actor_count = ?,
        matched_count = ?,
        weak_count = ?,
        ambiguous_count = ?,
        unmatched_count = ?,
        llm_request_count = ?,
        source_summary_json = ?
    WHERE id = ?
  `).run(
    status,
    error,
    result.notificationsCount,
    result.wallPostCount,
    result.activityCount,
    result.actorCount,
    result.matchedCount,
    result.weakCount,
    result.ambiguousCount,
    result.unmatchedCount,
    result.llmRequestCount,
    JSON.stringify(result.sourceSummary),
    runId,
  );
}

function persistActorsAndActivities(
  db: Database.Database,
  actors: VkSocialActor[],
  activities: VkSocialActivity[],
  matches: Map<number, MatchVerdict>,
) {
  const insertActor = db.prepare(`
    INSERT INTO vk_social_actors(
      vk_user_id,
      first_name,
      last_name,
      display_name,
      is_closed,
      action_summary_json,
      activity_count,
      last_seen_at,
      match_status,
      match_method,
      match_confidence,
      matched_special_application_id,
      match_reason,
      match_checked_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(vk_user_id) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      display_name = excluded.display_name,
      is_closed = excluded.is_closed,
      action_summary_json = excluded.action_summary_json,
      activity_count = excluded.activity_count,
      last_seen_at = excluded.last_seen_at,
      match_status = excluded.match_status,
      match_method = excluded.match_method,
      match_confidence = excluded.match_confidence,
      matched_special_application_id = excluded.matched_special_application_id,
      match_reason = excluded.match_reason,
      match_checked_at = excluded.match_checked_at,
      updated_at = excluded.updated_at
  `);
  const insertActivity = db.prepare(`
    INSERT OR IGNORE INTO vk_social_activities(
      activity_key,
      source,
      action,
      vk_user_id,
      group_id,
      post_id,
      comment_id,
      activity_date,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    for (const actor of actors) {
      const match = matches.get(actor.vkUserId);
      insertActor.run(
        actor.vkUserId,
        actor.firstName,
        actor.lastName,
        actor.displayName,
        actor.isClosed == null ? null : actor.isClosed ? 1 : 0,
        JSON.stringify([...actor.actions].sort()),
        actor.activityCount,
        actor.lastSeenAt,
        match?.status ?? 'unmatched',
        match?.method ?? null,
        match?.confidence ?? 0,
        match?.matchedSpecialApplicationId ?? null,
        match?.reason.slice(0, 500) ?? null,
      );
    }
    for (const activity of activities) {
      insertActivity.run(
        activity.activityKey,
        activity.source,
        activity.action,
        activity.vkUserId,
        activity.groupId,
        activity.postId,
        activity.commentId,
        activity.activityDate,
        JSON.stringify(activity.payload),
      );
    }
  });
  transaction();
}

function actionLabel(action: string) {
  switch (action) {
    case 'like_post': return 'лайки постов';
    case 'comment_post': return 'комментарии';
    case 'reply_comment': return 'ответы в комментариях';
    case 'like_comment': return 'лайки комментариев';
    case 'repost_post': return 'репосты';
    case 'like_video': return 'лайки видео';
    default: return action;
  }
}

function sourceLabel(source: string) {
  switch (source) {
    case 'notifications': return 'уведомления';
    case 'wall_scan': return 'скан стены';
    case 'wall_scan_copies': return 'репосты/копии без точного времени';
    case 'user_wall': return 'стены пользователей';
    default: return source;
  }
}

function parseHours(value: unknown, fallback = 24) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 168 ? parsed : fallback;
}

function parseReportMode(value: unknown): VkSocialReportMode {
  return value === 'rolling' ? 'rolling' : 'delta';
}

function tableExists(db: Database.Database, tableName: string) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function completedRunById(db: Database.Database, runId: number) {
  if (!Number.isFinite(runId) || runId <= 0 || !tableExists(db, 'vk_social_runs')) return null;
  const row = db.prepare(`
    SELECT id, finished_at AS finishedAt
    FROM vk_social_runs
    WHERE id = ? AND status = 'completed' AND finished_at IS NOT NULL
    LIMIT 1
  `).get(runId) as { id: number; finishedAt: string } | undefined;
  return row ?? null;
}

function latestCompletedRun(db: Database.Database) {
  if (!tableExists(db, 'vk_social_runs')) return null;
  const row = db.prepare(`
    SELECT id, finished_at AS finishedAt
    FROM vk_social_runs
    WHERE status = 'completed' AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, id DESC
    LIMIT 1
  `).get() as { id: number; finishedAt: string } | undefined;
  return row ?? null;
}

function latestSentDeltaReportUntil(
  db: Database.Database,
  untilIso: string,
) {
  if (!tableExists(db, 'vk_social_reports')) return null;
  const row = db.prepare(`
    SELECT id, until_at AS untilAt
    FROM vk_social_reports
    WHERE mode = 'delta'
      AND status = 'sent'
      AND until_at <= ?
    ORDER BY until_at DESC, id DESC
    LIMIT 1
  `).get(untilIso) as { id: number; untilAt: string } | undefined;
  return row ?? null;
}

function previousCompletedRunUntil(
  db: Database.Database,
  untilIso: string,
  currentRunId: number | null,
) {
  if (!tableExists(db, 'vk_social_runs')) return null;
  const row = db.prepare(`
    SELECT id, finished_at AS finishedAt
    FROM vk_social_runs
    WHERE status = 'completed'
      AND finished_at IS NOT NULL
      AND finished_at < ?
      AND (? IS NULL OR id != ?)
    ORDER BY finished_at DESC, id DESC
    LIMIT 1
  `).get(untilIso, currentRunId, currentRunId) as { id: number; finishedAt: string } | undefined;
  return row ?? null;
}

function resolveVkSocialReportInterval(
  db: Database.Database,
  options: {
    hours?: number;
    now?: Date;
    mode?: VkSocialReportMode;
    currentRunId?: number;
    sinceIso?: string;
    untilIso?: string;
  } = {},
): VkSocialReportInterval {
  const mode = parseReportMode(options.mode);
  const hours = parseHours(options.hours, 24);
  const now = options.now ?? new Date();

  if (mode === 'rolling') {
    const untilIso = options.untilIso ?? now.toISOString();
    const until = new Date(untilIso);
    const since = options.sinceIso
      ? new Date(options.sinceIso)
      : new Date(until.getTime() - hours * 60 * 60 * 1000);
    return {
      mode,
      sinceIso: since.toISOString(),
      untilIso,
      sinceExclusive: false,
      hours,
      source: 'rolling_hours',
      currentRunId: null,
      previousReportId: null,
      previousRunId: null,
    };
  }

  const currentRun = options.currentRunId ? completedRunById(db, options.currentRunId) : null;
  const latestRun = currentRun ?? latestCompletedRun(db);
  const untilIso = options.untilIso ?? latestRun?.finishedAt ?? now.toISOString();
  const currentRunId = currentRun?.id ?? latestRun?.id ?? null;

  if (options.sinceIso) {
    const since = new Date(options.sinceIso);
    return {
      mode,
      sinceIso: since.toISOString(),
      untilIso,
      sinceExclusive: true,
      hours: Math.max(0, (new Date(untilIso).getTime() - since.getTime()) / (60 * 60 * 1000)),
      source: 'previous_sent_report',
      currentRunId,
      previousReportId: null,
      previousRunId: null,
    };
  }

  const previousReport = latestSentDeltaReportUntil(db, untilIso);
  if (previousReport) {
    const since = new Date(previousReport.untilAt);
    return {
      mode,
      sinceIso: previousReport.untilAt,
      untilIso,
      sinceExclusive: true,
      hours: Math.max(0, (new Date(untilIso).getTime() - since.getTime()) / (60 * 60 * 1000)),
      source: 'previous_sent_report',
      currentRunId,
      previousReportId: previousReport.id,
      previousRunId: null,
    };
  }

  const previousRun = previousCompletedRunUntil(db, untilIso, currentRunId);
  if (previousRun) {
    const since = new Date(previousRun.finishedAt);
    return {
      mode,
      sinceIso: previousRun.finishedAt,
      untilIso,
      sinceExclusive: true,
      hours: Math.max(0, (new Date(untilIso).getTime() - since.getTime()) / (60 * 60 * 1000)),
      source: 'previous_completed_run',
      currentRunId,
      previousReportId: null,
      previousRunId: previousRun.id,
    };
  }

  const until = new Date(untilIso);
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  return {
    mode,
    sinceIso: since.toISOString(),
    untilIso,
    sinceExclusive: false,
    hours,
    source: 'fallback_hours',
    currentRunId,
    previousReportId: null,
    previousRunId: null,
  };
}

function formatKaliningradDateTime(isoValue: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: DEFAULT_TIME_ZONE,
  }).format(new Date(isoValue));
}

function incrementCounter(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function loadSpecialApplicantNames(
  db: Database.Database,
  privateKeyPemBase64: string,
  ids: number[],
) {
  if (!ids.length) {
    return new Map<number, {
      id: number;
      applicationCode: string;
      fullName: string;
      eventTitle: string | null;
    }>();
  }

  const rows = db.prepare(`
    SELECT
      a.id,
      a.application_code,
      a.pii_ciphertext,
      a.pii_wrapped_key,
      a.pii_iv,
      a.pii_alg,
      e.title AS event_title
    FROM special_applications a
    LEFT JOIN special_events e ON e.id = a.special_event_id
    WHERE a.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as Array<{
    id: number;
    application_code: string;
    pii_ciphertext: Buffer;
    pii_wrapped_key: Buffer;
    pii_iv: Buffer;
    pii_alg: string;
    event_title: string | null;
  }>;

  const out = new Map<number, {
    id: number;
    applicationCode: string;
    fullName: string;
    eventTitle: string | null;
  }>();
  for (const row of rows) {
    const pii = decryptPii(privateKeyPemBase64, {
      piiCiphertext: row.pii_ciphertext,
      piiWrappedKey: row.pii_wrapped_key,
      piiIv: row.pii_iv,
      piiAlg: row.pii_alg,
    });
    out.set(row.id, {
      id: row.id,
      applicationCode: row.application_code,
      fullName: String(pii.fullName ?? '').trim() || `Заявка #${row.id}`,
      eventTitle: row.event_title,
    });
  }
  return out;
}

export function buildVkSocialDailyReport(
  db: Database.Database,
  privateKeyPemBase64: string,
  options: {
    hours?: number;
    now?: Date;
    mode?: VkSocialReportMode;
    currentRunId?: number;
    sinceIso?: string;
    untilIso?: string;
  } = {},
) {
  const interval = resolveVkSocialReportInterval(db, options);
  const hours = interval.hours;
  const sinceIso = interval.sinceIso;
  const untilIso = interval.untilIso;
  const lowerBoundOperator = interval.sinceExclusive ? '>' : '>=';
  const rows = db.prepare(`
    SELECT
      act.activity_key AS activityKey,
      act.source,
      act.action,
      act.vk_user_id AS vkUserId,
      act.group_id AS groupId,
      act.post_id AS postId,
      act.comment_id AS commentId,
      act.activity_date AS activityDate,
      actor.display_name AS vkDisplayName,
      actor.match_status AS matchStatus,
      actor.match_method AS matchMethod,
      actor.match_confidence AS matchConfidence,
      actor.matched_special_application_id AS matchedSpecialApplicationId
    FROM vk_social_activities act
    INNER JOIN vk_social_actors actor ON actor.vk_user_id = act.vk_user_id
    WHERE act.activity_date IS NOT NULL
      AND act.activity_date ${lowerBoundOperator} ?
      AND act.activity_date <= ?
      AND NOT (
        act.source IN ('wall_scan', 'wall_scan_copies')
        AND act.action IN ('like_post', 'repost_post')
      )
    ORDER BY act.activity_date DESC, act.id DESC
  `).all(sinceIso, untilIso) as Array<{
    activityKey: string;
    source: string;
    action: string;
    vkUserId: number;
    groupId: number | null;
    postId: number | null;
    commentId: number | null;
    activityDate: string;
    vkDisplayName: string;
    matchStatus: MatchStatus;
    matchMethod: MatchMethod | null;
    matchConfidence: number;
    matchedSpecialApplicationId: number | null;
  }>;

  const firstSeenWallScanRows = db.prepare(`
    SELECT
      act.activity_key AS activityKey,
      act.source,
      act.action,
      act.vk_user_id AS vkUserId,
      act.group_id AS groupId,
      act.post_id AS postId,
      act.comment_id AS commentId,
      act.activity_date AS activityDate,
      act.created_at AS detectedAt,
      actor.display_name AS vkDisplayName,
      actor.match_status AS matchStatus,
      actor.match_confidence AS matchConfidence,
      actor.matched_special_application_id AS matchedSpecialApplicationId
    FROM vk_social_activities act
    INNER JOIN vk_social_actors actor ON actor.vk_user_id = act.vk_user_id
    WHERE act.created_at ${lowerBoundOperator} ?
      AND act.created_at <= ?
      AND act.source IN ('wall_scan', 'wall_scan_copies')
      AND act.action IN ('like_post', 'repost_post')
    ORDER BY act.created_at DESC, act.id DESC
  `).all(sinceIso, untilIso) as Array<{
    activityKey: string;
    source: string;
    action: string;
    vkUserId: number;
    groupId: number | null;
    postId: number | null;
    commentId: number | null;
    activityDate: string | null;
    detectedAt: string;
    vkDisplayName: string;
    matchStatus: MatchStatus;
    matchConfidence: number;
    matchedSpecialApplicationId: number | null;
  }>;

  const matchedIds = [...new Set([
    ...rows
    .filter((row) => ['matched', 'weak'].includes(row.matchStatus) && row.matchedSpecialApplicationId)
    .map((row) => Number(row.matchedSpecialApplicationId)),
    ...firstSeenWallScanRows
      .filter((row) => ['matched', 'weak'].includes(row.matchStatus) && row.matchedSpecialApplicationId)
      .map((row) => Number(row.matchedSpecialApplicationId)),
  ])];
  const applicants = loadSpecialApplicantNames(db, privateKeyPemBase64, matchedIds);
  const people = new Map<number, {
    specialApplicationId: number;
    applicationCode: string;
    fullName: string;
    eventTitle: string | null;
    matchStatus: MatchStatus;
    matchConfidence: number;
    vkDisplayNames: Set<string>;
    totalActions: number;
    actions: Record<string, number>;
    sources: Record<string, number>;
    latestActivityAt: string | null;
  }>();

  const stats = {
    mode: interval.mode,
    hours,
    sinceIso,
    untilIso,
    sinceExclusive: interval.sinceExclusive,
    intervalSource: interval.source,
    currentRunId: interval.currentRunId,
    previousReportId: interval.previousReportId,
    previousRunId: interval.previousRunId,
    totalActivities: rows.length,
    uniqueVkActors: new Set(rows.map((row) => row.vkUserId)).size,
    matchedPeople: 0,
    actions: {} as Record<string, number>,
    sources: {} as Record<string, number>,
    byMatchStatus: {} as Record<string, number>,
    firstSeenWallScanActivities: firstSeenWallScanRows.length,
    firstSeenWallScanMatchedPeople: 0,
    firstSeenWallScanActions: {} as Record<string, number>,
  };

  const statusActorSets = new Map<string, Set<number>>();
  for (const row of rows) {
    incrementCounter(stats.actions, row.action);
    incrementCounter(stats.sources, row.source);
    const statusSet = statusActorSets.get(row.matchStatus) ?? new Set<number>();
    statusSet.add(row.vkUserId);
    statusActorSets.set(row.matchStatus, statusSet);

    if (!['matched', 'weak'].includes(row.matchStatus) || !row.matchedSpecialApplicationId) {
      continue;
    }
    const applicant = applicants.get(row.matchedSpecialApplicationId);
    if (!applicant) continue;
    const current = people.get(row.matchedSpecialApplicationId) ?? {
      specialApplicationId: row.matchedSpecialApplicationId,
      applicationCode: applicant.applicationCode,
      fullName: applicant.fullName,
      eventTitle: applicant.eventTitle,
      matchStatus: row.matchStatus,
      matchConfidence: Number(row.matchConfidence ?? 0),
      vkDisplayNames: new Set<string>(),
      totalActions: 0,
      actions: {},
      sources: {},
      latestActivityAt: null,
    };
    current.matchStatus = current.matchStatus === 'matched' || row.matchStatus === 'matched' ? 'matched' : row.matchStatus;
    current.matchConfidence = Math.max(current.matchConfidence, Number(row.matchConfidence ?? 0));
    current.vkDisplayNames.add(row.vkDisplayName);
    current.totalActions += 1;
    incrementCounter(current.actions, row.action);
    incrementCounter(current.sources, row.source);
    if (!current.latestActivityAt || row.activityDate > current.latestActivityAt) {
      current.latestActivityAt = row.activityDate;
    }
    people.set(row.matchedSpecialApplicationId, current);
  }

  for (const [status, set] of statusActorSets) {
    stats.byMatchStatus[status] = set.size;
  }

  const peopleRows = [...people.values()]
    .sort((left, right) => right.totalActions - left.totalActions || left.fullName.localeCompare(right.fullName, 'ru'))
    .map((person) => ({
      ...person,
      vkDisplayNames: [...person.vkDisplayNames].sort(),
    }));
  stats.matchedPeople = peopleRows.length;

  const firstSeenPeople = new Map<number, {
    specialApplicationId: number;
    applicationCode: string;
    fullName: string;
    eventTitle: string | null;
    matchStatus: MatchStatus;
    matchConfidence: number;
    vkDisplayNames: Set<string>;
    totalActions: number;
    actions: Record<string, number>;
    latestDetectedAt: string | null;
  }>();

  for (const row of firstSeenWallScanRows) {
    incrementCounter(stats.firstSeenWallScanActions, row.action);
    if (!['matched', 'weak'].includes(row.matchStatus) || !row.matchedSpecialApplicationId) {
      continue;
    }
    const applicant = applicants.get(row.matchedSpecialApplicationId);
    if (!applicant) continue;
    const current = firstSeenPeople.get(row.matchedSpecialApplicationId) ?? {
      specialApplicationId: row.matchedSpecialApplicationId,
      applicationCode: applicant.applicationCode,
      fullName: applicant.fullName,
      eventTitle: applicant.eventTitle,
      matchStatus: row.matchStatus,
      matchConfidence: Number(row.matchConfidence ?? 0),
      vkDisplayNames: new Set<string>(),
      totalActions: 0,
      actions: {},
      latestDetectedAt: null,
    };
    current.matchStatus = current.matchStatus === 'matched' || row.matchStatus === 'matched' ? 'matched' : row.matchStatus;
    current.matchConfidence = Math.max(current.matchConfidence, Number(row.matchConfidence ?? 0));
    current.vkDisplayNames.add(row.vkDisplayName);
    current.totalActions += 1;
    incrementCounter(current.actions, row.action);
    if (!current.latestDetectedAt || row.detectedAt > current.latestDetectedAt) {
      current.latestDetectedAt = row.detectedAt;
    }
    firstSeenPeople.set(row.matchedSpecialApplicationId, current);
  }

  const firstSeenPeopleRows = [...firstSeenPeople.values()]
    .sort((left, right) => right.totalActions - left.totalActions || left.fullName.localeCompare(right.fullName, 'ru'))
    .map((person) => ({
      ...person,
      vkDisplayNames: [...person.vkDisplayNames].sort(),
    }));
  stats.firstSeenWallScanMatchedPeople = firstSeenPeopleRows.length;

  const actionStats = Object.entries(stats.actions)
    .sort((left, right) => right[1] - left[1])
    .map(([action, count]) => `${actionLabel(action)}: ${count}`)
    .join(', ') || 'нет';
  const sourceStats = Object.entries(stats.sources)
    .sort((left, right) => right[1] - left[1])
    .map(([source, count]) => `${sourceLabel(source)}: ${count}`)
    .join(', ') || 'нет';
  const matchStats = Object.entries(stats.byMatchStatus)
    .sort((left, right) => right[1] - left[1])
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ') || 'нет';
  const firstSeenActionStats = Object.entries(stats.firstSeenWallScanActions)
    .sort((left, right) => right[1] - left[1])
    .map(([action, count]) => `${actionLabel(action)}: ${count}`)
    .join(', ') || 'нет';

  const title = interval.mode === 'delta'
    ? 'VK социальная активность без нахлёста'
    : `VK социальная активность за ${Number(hours.toFixed(1))} ч. (rolling-аудит)`;
  const intervalHint = interval.mode === 'delta'
    ? interval.source === 'previous_sent_report'
      ? 'период: после прошлого успешного отчёта'
      : interval.source === 'previous_completed_run'
        ? 'период: после предыдущего успешного запуска мониторинга'
        : 'период: первый отчёт, fallback-окно'
    : 'период: rolling-окно; соседние отчёты могут пересекаться';
  const exactActivityLabel = interval.mode === 'delta' ? 'новых точных действий' : 'точных действий';
  const firstSeenLabel = interval.mode === 'delta'
    ? 'новых впервые найденных сканом без точного времени VK'
    : 'дополнительно впервые найдено сканом без точного времени VK';

  const lines = [
    title,
    `${formatKaliningradDateTime(sinceIso)} — ${formatKaliningradDateTime(untilIso)} Калининград`,
    intervalHint,
    '',
    'Статистика:',
    `• ${exactActivityLabel}: ${stats.totalActivities}`,
    `• VK-акторов: ${stats.uniqueVkActors}`,
    `• людей с ФИО в спецзаявках: ${stats.matchedPeople}`,
    `• по типам: ${actionStats}`,
    `• по источникам: ${sourceStats}`,
    `• по качеству матчинга VK-акторов: ${matchStats}`,
    `• ${firstSeenLabel}: ${stats.firstSeenWallScanActivities}; по типам: ${firstSeenActionStats}; людей с ФИО: ${stats.firstSeenWallScanMatchedPeople}`,
    interval.mode === 'delta'
      ? '• Важно: отчёт показывает только дельту после прошлого отчёта/запуска, без повторного rolling-нахлёста.'
      : '• Важно: это rolling-аудит; при запуске каждые 12 часов соседние 24-часовые окна пересекаются.',
    '• Важно: VK wall scan не отдаёт время лайка/копии. Такие лайки/копии ниже показаны отдельно как впервые обнаруженные сканом за период, а не как точное время действия.',
    '',
    'ФИО и активности:',
  ];

  if (!peopleRows.length) {
    lines.push('За период нет активностей, сопоставленных со спецзаявками по ФИО.');
  } else {
    peopleRows.slice(0, 60).forEach((person, index) => {
      const actions = Object.entries(person.actions)
        .sort((left, right) => right[1] - left[1])
        .map(([action, count]) => `${actionLabel(action)} ${count}`)
        .join(', ');
      const weakMark = person.matchStatus === 'weak' ? ' ⚠️ weak' : '';
      lines.push(`${index + 1}. ${person.fullName}${weakMark}`);
      lines.push(`   ${actions}; всего ${person.totalActions}; VK: ${person.vkDisplayNames.join(', ')}`);
      if (person.eventTitle) lines.push(`   спец: ${person.eventTitle}; код: ${person.applicationCode}`);
      if (person.latestActivityAt) lines.push(`   последнее: ${formatKaliningradDateTime(person.latestActivityAt)}`);
    });
    if (peopleRows.length > 60) {
      lines.push(`…ещё ${peopleRows.length - 60} человек не вошли в короткое Telegram-сообщение.`);
    }
  }

  if (firstSeenPeopleRows.length) {
    lines.push('', 'Дополнительно найдено сканом без точного времени VK:');
    firstSeenPeopleRows.slice(0, 40).forEach((person, index) => {
      const actions = Object.entries(person.actions)
        .sort((left, right) => right[1] - left[1])
        .map(([action, count]) => `${actionLabel(action)} ${count}`)
        .join(', ');
      const weakMark = person.matchStatus === 'weak' ? ' ⚠️ weak' : '';
      lines.push(`${index + 1}. ${person.fullName}${weakMark}`);
      lines.push(`   ${actions}; всего ${person.totalActions}; VK: ${person.vkDisplayNames.join(', ')}`);
      if (person.eventTitle) lines.push(`   спец: ${person.eventTitle}; код: ${person.applicationCode}`);
      if (person.latestDetectedAt) lines.push(`   обнаружено: ${formatKaliningradDateTime(person.latestDetectedAt)}`);
    });
    if (firstSeenPeopleRows.length > 40) {
      lines.push(`…ещё ${firstSeenPeopleRows.length - 40} человек не вошли в короткое Telegram-сообщение.`);
    }
  }

  lines.push('', 'Баллы не изменялись: отчётный режим v1.');

  return {
    generatedAt: untilIso,
    reportKey: `${interval.mode}:${sinceIso}:${untilIso}`,
    stats,
    people: peopleRows,
    firstSeenWallScanPeople: firstSeenPeopleRows,
    text: lines.join('\n'),
  };
}

function splitTelegramText(text: string) {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 3_800) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function startVkSocialReportDelivery(
  db: Database.Database,
  report: ReturnType<typeof buildVkSocialDailyReport>,
  runId: number | null,
) {
  if (!tableExists(db, 'vk_social_reports')) {
    return { reportId: null, alreadySent: false };
  }

  const existing = db.prepare(`
    SELECT id, status
    FROM vk_social_reports
    WHERE report_key = ?
    LIMIT 1
  `).get(report.reportKey) as { id: number; status: string } | undefined;
  if (existing?.status === 'sent') {
    return { reportId: existing.id, alreadySent: true };
  }

  const textHash = crypto.createHash('sha256').update(report.text).digest('hex');
  const row = db.prepare(`
    INSERT INTO vk_social_reports(
      report_key,
      mode,
      status,
      run_id,
      since_at,
      until_at,
      since_exclusive,
      text_hash,
      telegram_message_count,
      error,
      updated_at
    ) VALUES (?, ?, 'sending', ?, ?, ?, ?, ?, 0, NULL, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ON CONFLICT(report_key) DO UPDATE SET
      status = 'sending',
      run_id = excluded.run_id,
      since_at = excluded.since_at,
      until_at = excluded.until_at,
      since_exclusive = excluded.since_exclusive,
      text_hash = excluded.text_hash,
      telegram_message_count = 0,
      error = NULL,
      updated_at = excluded.updated_at
    RETURNING id
  `).get(
    report.reportKey,
    report.stats.mode,
    runId,
    report.stats.sinceIso,
    report.stats.untilIso,
    report.stats.sinceExclusive ? 1 : 0,
    textHash,
  ) as { id: number };
  return { reportId: row.id, alreadySent: false };
}

function markVkSocialReportSent(db: Database.Database, reportId: number | null, telegramMessageCount: number) {
  if (!reportId || !tableExists(db, 'vk_social_reports')) return;
  db.prepare(`
    UPDATE vk_social_reports
    SET status = 'sent',
        sent_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        telegram_message_count = ?,
        error = NULL,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).run(telegramMessageCount, reportId);
}

function markVkSocialReportFailed(db: Database.Database, reportId: number | null, error: unknown) {
  if (!reportId || !tableExists(db, 'vk_social_reports')) return;
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`
    UPDATE vk_social_reports
    SET status = 'failed',
        error = ?,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).run(message.slice(0, 500), reportId);
}

export async function sendVkSocialDailyReportToTelegram(deps: {
  db: Database.Database;
  bot: Bot<Context>;
  privateKeyPemBase64: string;
  hours?: number;
  mode?: VkSocialReportMode;
  currentRunId?: number;
}) {
  const superadmins = listTelegramAdmins(deps.db).filter((item) => item.role === 'superadmin');
  if (!superadmins.length) {
    return false;
  }

  const report = buildVkSocialDailyReport(deps.db, deps.privateKeyPemBase64, {
    hours: deps.hours ?? 24,
    mode: deps.mode ?? 'delta',
    currentRunId: deps.currentRunId,
  });
  const delivery = startVkSocialReportDelivery(deps.db, report, deps.currentRunId ?? report.stats.currentRunId);
  if (delivery.alreadySent) {
    return false;
  }
  const chunks = splitTelegramText(report.text);
  try {
    const results = await Promise.allSettled(superadmins.flatMap((admin) => (
      chunks.map((chunk) => deps.bot.api.sendMessage(admin.telegramUserId, chunk))
    )));
    const rejected = results.filter((item) => item.status === 'rejected');
    if (rejected.length === results.length) {
      const error = new Error('Failed to deliver VK social daily report to every superadmin.');
      markVkSocialReportFailed(deps.db, delivery.reportId, error);
      throw error;
    }
    markVkSocialReportSent(deps.db, delivery.reportId, results.length - rejected.length);
    return true;
  } catch (error) {
    markVkSocialReportFailed(deps.db, delivery.reportId, error);
    throw error;
  }
}

export async function runVkSocialMonitoring(deps: VkSocialRunDeps): Promise<VkSocialRunResult> {
  const dryRun = deps.dryRun ?? false;
  const trigger = deps.trigger ?? (dryRun ? 'dry_run' : 'manual');
  const runKey = deps.runKey ?? createRunKey();
  let runId = 0;
  if (!dryRun) {
    const row = deps.db.prepare(`
      INSERT INTO vk_social_runs(run_key, trigger, status)
      VALUES (?, ?, 'running')
      RETURNING id
    `).get(runKey, trigger) as { id: number };
    runId = row.id;
  }

  const actors = new Map<number, VkSocialActor>();
  const activities = new Map<string, VkSocialActivity>();
  try {
    const client = new VkApiClient(deps.token);
    const futureSignatures = loadFutureEventSignatures(deps.db);
    const notificationsCount = await collectNotifications(client, actors, activities, futureSignatures);
    const wallPostCount = await collectWallBackfill(client, actors, activities, futureSignatures);
    const applicants = loadSpecialApplicants(deps.db, deps.privateKeyPemBase64);
    let actorList = [...actors.values()].sort((left, right) => right.activityCount - left.activityCount);
    const matchResult = await matchActors(deps.db, actorList, applicants, dryRun);
    const userWallStats = await collectMatchedUserWallReposts(client, actors, activities, matchResult.results, futureSignatures);
    actorList = [...actors.values()].sort((left, right) => right.activityCount - left.activityCount);
    if (!dryRun) {
      persistActorsAndActivities(deps.db, actorList, [...activities.values()], matchResult.results);
    }
    const result: VkSocialRunResult = {
      runKey,
      dryRun,
      notificationsCount,
      wallPostCount,
      activityCount: activities.size,
      actorCount: actorList.length,
      matchedCount: countByStatus(matchResult.results, 'matched'),
      weakCount: countByStatus(matchResult.results, 'weak'),
      ambiguousCount: countByStatus(matchResult.results, 'ambiguous'),
      unmatchedCount: countByStatus(matchResult.results, 'unmatched'),
      llmRequestCount: matchResult.llmRequestCount,
      telegramReportSent: false,
      sourceSummary: {
        groups: DEFAULT_GROUPS,
        wallPostCount,
        notificationsCount,
        futureEventSignatureCount: futureSignatures.length,
        userWallRepostCount: userWallStats.userWallRepostCount,
        scannedUserWallPosts: userWallStats.scannedUserWallPosts,
      },
      actors: actorList.map((actor) => ({
        vkUserId: actor.vkUserId,
        displayName: actor.displayName,
        actions: [...actor.actions].sort(),
        activityCount: actor.activityCount,
        match: matchResult.results.get(actor.vkUserId)!,
      })),
    };
    if (!dryRun) {
      persistRun(deps.db, runId, result, 'completed');
    }
    if (!dryRun && deps.sendTelegramReport && deps.bot && deps.privateKeyPemBase64) {
      try {
        result.telegramReportSent = await sendVkSocialDailyReportToTelegram({
        db: deps.db,
        bot: deps.bot,
        privateKeyPemBase64: deps.privateKeyPemBase64,
        mode: 'delta',
        currentRunId: runId,
        hours: deps.reportHours ?? 24,
      });
      } catch (telegramError) {
        deps.logger?.error({ err: telegramError, runKey }, 'vk_social_telegram_report_failed');
      }
    }
    deps.logger?.info({
      runKey,
      actorCount: result.actorCount,
      activityCount: result.activityCount,
      matchedCount: result.matchedCount,
      weakCount: result.weakCount,
      ambiguousCount: result.ambiguousCount,
      unmatchedCount: result.unmatchedCount,
    }, 'vk_social_monitoring_completed');
    return result;
  } catch (error) {
    if (!dryRun && runId) {
      const empty = {
        runKey,
        dryRun,
        notificationsCount: 0,
        wallPostCount: 0,
        activityCount: 0,
        actorCount: 0,
        matchedCount: 0,
        weakCount: 0,
        ambiguousCount: 0,
        unmatchedCount: 0,
        llmRequestCount: 0,
        telegramReportSent: false,
        sourceSummary: {},
      };
      persistRun(deps.db, runId, empty, 'failed', error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500));
    }
    throw error;
  }
}

export function getVkSocialReport(db: Database.Database) {
  const latestRun = db.prepare(`
    SELECT *
    FROM vk_social_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  const actors = db.prepare(`
    SELECT
      vk_user_id AS vkUserId,
      display_name AS displayName,
      action_summary_json AS actionSummaryJson,
      activity_count AS activityCount,
      last_seen_at AS lastSeenAt,
      match_status AS matchStatus,
      match_method AS matchMethod,
      match_confidence AS matchConfidence,
      matched_special_application_id AS matchedSpecialApplicationId,
      match_reason AS matchReason,
      match_checked_at AS matchCheckedAt
    FROM vk_social_actors
    ORDER BY
      CASE match_status
        WHEN 'matched' THEN 1
        WHEN 'weak' THEN 2
        WHEN 'ambiguous' THEN 3
        ELSE 4
      END,
      activity_count DESC
  `).all() as Array<Record<string, unknown>>;
  const byStatus = db.prepare(`
    SELECT match_status AS status, COUNT(*) AS count
    FROM vk_social_actors
    GROUP BY match_status
  `).all() as Array<{ status: string; count: number }>;
  return {
    latestRun,
    summary: byStatus.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {}),
    actors: actors.map((actor) => ({
      ...actor,
      actionSummary: JSON.parse(String(actor.actionSummaryJson || '[]')) as string[],
      actionSummaryJson: undefined,
    })),
  };
}

export function startVkSocialMonitoring(deps: {
  db: Database.Database;
  token: string | null;
  privateKeyPemBase64: string | null;
  logger: FastifyBaseLogger;
  timeZone: string;
  bot?: Bot<Context>;
}) {
  let running = false;
  const tick = async () => {
    if (running || !deps.token || !deps.privateKeyPemBase64) return;
    const runKey = getDueVkSocialRunKey(deps.db, new Date(), deps.timeZone || DEFAULT_TIME_ZONE);
    if (!runKey) return;
    running = true;
    try {
      await runVkSocialMonitoring({
        db: deps.db,
        token: deps.token,
        privateKeyPemBase64: deps.privateKeyPemBase64,
        logger: deps.logger,
        trigger: 'scheduled',
        runKey,
        bot: deps.bot,
        sendTelegramReport: Boolean(deps.bot),
        reportHours: 24,
      });
    } catch (error) {
      deps.logger.error({ err: error, runKey }, 'vk_social_monitoring_failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
