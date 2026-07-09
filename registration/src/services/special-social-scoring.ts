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
  if (!uniqueIds.length || !tableExists(db, 'vk_social_actors') || !tableExists(db, 'vk_social_activities')) {
    return out;
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    WITH target_applications AS (
      SELECT id, participant_profile_id
      FROM special_applications
      WHERE id IN (${placeholders})
    )
    SELECT
      target.id AS applicationId,
      act.action AS action,
      COALESCE(act.activity_date, act.created_at) AS occurredAt
    FROM target_applications target
    INNER JOIN vk_social_actors actor
      ON actor.match_status = 'matched'
      AND actor.match_confidence >= ?
    INNER JOIN special_applications matched_app
      ON matched_app.id = actor.matched_special_application_id
    INNER JOIN vk_social_activities act ON act.vk_user_id = actor.vk_user_id
    WHERE actor.matched_special_application_id = target.id
      OR (
        target.participant_profile_id IS NOT NULL
        AND matched_app.participant_profile_id = target.participant_profile_id
      )
    ORDER BY occurredAt ASC, act.id ASC
  `).all(...uniqueIds, MATCH_CONFIDENCE_MIN) as Array<{
    applicationId: number;
    action: string;
    occurredAt: string | null;
  }>;

  const grouped = new Map<number, SocialRaffleActivityInput[]>();
  for (const row of rows) {
    const applicationId = Number(row.applicationId);
    if (!out.has(applicationId)) {
      continue;
    }
    const list = grouped.get(applicationId) ?? [];
    list.push({ action: row.action, occurredAt: row.occurredAt });
    grouped.set(applicationId, list);
  }

  for (const applicationId of uniqueIds) {
    out.set(applicationId, computeSocialRaffleBonusFromActivities(applicationId, grouped.get(applicationId) ?? []));
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
