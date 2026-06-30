import type Database from 'better-sqlite3';
import type { VkSocialAction } from './vk-social-monitoring';

export type SocialRaffleActionCounts = Partial<Record<VkSocialAction, number>>;

export type SocialRaffleBonus = {
  applicationId: number;
  bonusPoints: number;
  rawPoints: number;
  activeDays: number;
  eligibleActivityCount: number;
  actions: SocialRaffleActionCounts;
  latestActivityAt: string | null;
};

type SocialRaffleActivityInput = {
  action: VkSocialAction | string;
  occurredAt: string | null;
};

const DEFAULT_TIME_ZONE = 'Europe/Kaliningrad';
const MATCH_CONFIDENCE_MIN = 0.85;

const ACTION_WEIGHTS: Record<VkSocialAction, number> = {
  repost_post: 0.6,
  comment_post: 0.25,
  reply_comment: 0.25,
  like_post: 0.15,
  like_video: 0.15,
  like_comment: 0.05,
};

const DAILY_CATEGORY_CAPS = {
  repost: 1,
  comment: 0.5,
  postLike: 0.5,
  commentLike: 0.1,
} as const;

const DAILY_TOTAL_CAP = 1.2;

function isVkSocialAction(value: string): value is VkSocialAction {
  return value in ACTION_WEIGHTS;
}

function dayKey(value: string, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function categoryForAction(action: VkSocialAction): keyof typeof DAILY_CATEGORY_CAPS {
  if (action === 'repost_post') return 'repost';
  if (action === 'comment_post' || action === 'reply_comment') return 'comment';
  if (action === 'like_comment') return 'commentLike';
  return 'postLike';
}

function emptyBonus(applicationId: number): SocialRaffleBonus {
  return {
    applicationId,
    bonusPoints: 0,
    rawPoints: 0,
    activeDays: 0,
    eligibleActivityCount: 0,
    actions: {},
    latestActivityAt: null,
  };
}

export function computeSocialRaffleBonusFromActivities(
  applicationId: number,
  activities: SocialRaffleActivityInput[],
  options: { timeZone?: string } = {},
): SocialRaffleBonus {
  const bonus = emptyBonus(applicationId);
  const perDay = new Map<string, Record<keyof typeof DAILY_CATEGORY_CAPS, number>>();

  for (const activity of activities) {
    const action = String(activity.action || '');
    if (!isVkSocialAction(action) || !activity.occurredAt) {
      continue;
    }
    const key = dayKey(activity.occurredAt, options.timeZone);
    if (!key) {
      continue;
    }

    bonus.eligibleActivityCount += 1;
    bonus.actions[action] = (bonus.actions[action] ?? 0) + 1;
    if (!bonus.latestActivityAt || activity.occurredAt > bonus.latestActivityAt) {
      bonus.latestActivityAt = activity.occurredAt;
    }

    const category = categoryForAction(action);
    const day = perDay.get(key) ?? {
      repost: 0,
      comment: 0,
      postLike: 0,
      commentLike: 0,
    };
    day[category] += ACTION_WEIGHTS[action];
    perDay.set(key, day);
  }

  let rawPoints = 0;
  for (const day of perDay.values()) {
    const cappedDayScore = Math.min(
      DAILY_TOTAL_CAP,
      Math.min(day.repost, DAILY_CATEGORY_CAPS.repost)
        + Math.min(day.comment, DAILY_CATEGORY_CAPS.comment)
        + Math.min(day.postLike, DAILY_CATEGORY_CAPS.postLike)
        + Math.min(day.commentLike, DAILY_CATEGORY_CAPS.commentLike),
    );
    rawPoints += cappedDayScore;
  }

  const roundedRawPoints = Number(rawPoints.toFixed(4));
  bonus.activeDays = perDay.size;
  bonus.rawPoints = roundedRawPoints;
  bonus.bonusPoints = Math.max(0, Math.floor(roundedRawPoints + 1e-9));
  return bonus;
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

export function loadSocialRaffleBonuses(
  db: Database.Database,
  applicationIds: number[],
): Map<number, SocialRaffleBonus> {
  const uniqueIds = [...new Set(applicationIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, SocialRaffleBonus>(uniqueIds.map((id) => [id, emptyBonus(id)]));
  if (!uniqueIds.length || !tableExists(db, 'vk_social_actors') || !tableExists(db, 'vk_social_activities') || !tableExists(db, 'special_applications')) {
    return out;
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const requestedRows = db.prepare(`
    SELECT id, full_name_fingerprint AS fullNameFingerprint
    FROM special_applications
    WHERE id IN (${placeholders})
  `).all(...uniqueIds) as Array<{ id: number; fullNameFingerprint: string | null }>;
  const fingerprintByApplicationId = new Map<number, string>();
  for (const row of requestedRows) {
    const fingerprint = String(row.fullNameFingerprint ?? '').trim();
    if (fingerprint) {
      fingerprintByApplicationId.set(row.id, fingerprint);
    }
  }
  const fingerprints = [...new Set(fingerprintByApplicationId.values())];
  if (!fingerprints.length) {
    return out;
  }

  const fingerprintPlaceholders = fingerprints.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      matched.full_name_fingerprint AS fullNameFingerprint,
      act.action AS action,
      COALESCE(act.activity_date, act.created_at) AS occurredAt
    FROM vk_social_activities act
    INNER JOIN vk_social_actors actor ON actor.vk_user_id = act.vk_user_id
    INNER JOIN special_applications matched ON matched.id = actor.matched_special_application_id
    WHERE matched.full_name_fingerprint IN (${fingerprintPlaceholders})
      AND actor.match_status = 'matched'
      AND actor.match_confidence >= ?
    ORDER BY occurredAt ASC, act.id ASC
  `).all(...fingerprints, MATCH_CONFIDENCE_MIN) as Array<{
    fullNameFingerprint: string;
    action: string;
    occurredAt: string | null;
  }>;

  const grouped = new Map<string, SocialRaffleActivityInput[]>();
  for (const row of rows) {
    const fingerprint = String(row.fullNameFingerprint ?? '').trim();
    if (!fingerprint) {
      continue;
    }
    const list = grouped.get(fingerprint) ?? [];
    list.push({ action: row.action, occurredAt: row.occurredAt });
    grouped.set(fingerprint, list);
  }

  for (const applicationId of uniqueIds) {
    const fingerprint = fingerprintByApplicationId.get(applicationId);
    out.set(applicationId, computeSocialRaffleBonusFromActivities(applicationId, fingerprint ? grouped.get(fingerprint) ?? [] : []));
  }
  return out;
}

export function formatSocialRaffleActionCounts(actions: SocialRaffleActionCounts) {
  const labels: Record<VkSocialAction, string> = {
    repost_post: 'репосты',
    comment_post: 'комментарии',
    reply_comment: 'ответы',
    like_post: 'лайки постов',
    like_video: 'лайки видео',
    like_comment: 'лайки комментариев',
  };
  return (Object.entries(actions) as Array<[VkSocialAction, number]>)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([action, count]) => `${labels[action]} ${count}`)
    .join(', ') || 'нет';
}
