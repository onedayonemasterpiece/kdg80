import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import type Database from 'better-sqlite3';
import { decryptPii } from '../lib/crypto';
import { loadSocialRaffleBonuses, type SocialRaffleBonus } from './special-social-scoring';

type SpecialEventRow = {
  id: number;
  slug: string;
  title: string;
  format_label: string;
  venue_name: string;
  previous_winner_weight_percent: number;
  auto_draw_lead_hours: number;
  requires_russian_citizenship: number;
  winner_email_enabled: number;
  winner_response_deadline_hours: number;
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

type SpecialApplicationRow = {
  id: number;
  application_code: string;
  participant_profile_id: number | null;
  pii_ciphertext: Buffer;
  pii_wrapped_key: Buffer;
  pii_iv: Buffer;
  pii_alg: string;
  selected_showing_ids_json: string;
  status: string;
  russian_citizenship_confirmed: number;
  uploaded_photo_count: number;
  unique_photo_count: number;
  accepted_photo_count: number;
  stamp_count: number;
  ordinary_registration_count: number;
  no_show_count: number;
  score: number;
  created_at: string;
};

type SpecialCandidateRow = SpecialApplicationRow & {
  previous_special_winner: number;
  previous_winner_weight_percent: number;
};

type SpecialPhotoRow = {
  id: number;
  application_id: number;
  storage_key: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  duplicate_of_sha256: string | null;
  has_full_name: number;
  stamp_count: number;
  accepted: number;
  confidence: number;
};

type SpecialDrawRunRow = {
  id: number;
  showing_id: number;
  run_type: 'draft' | 'published';
  snapshot_json: string;
  result_json: string;
  created_at: string;
};

export type SpecialDrawRunType = 'draft' | 'published';

export type SpecialAutoDrawDueShowing = {
  event: SpecialEventRow;
  showing: SpecialShowingRow;
  autoPublishAt: string;
};

export type SpecialParticipant = {
  applicationId: number;
  applicationCode: string;
  participantProfileId: number | null;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  baseScore: number;
  socialBonusPoints: number;
  socialBonusRawPoints: number;
  socialBonusActiveDays: number;
  socialBonusEligibleActivityCount: number;
  socialBonusLatestActivityAt: string | null;
  score: number;
  stampCount: number;
  ordinaryRegistrationCount: number;
  noShowCount: number;
  uploadedPhotoCount: number;
  uniquePhotoCount: number;
  acceptedPhotoCount: number;
  selectedShowingCount: number;
  previousSpecialWinner: boolean;
  previousWinnerWeightPercent: number;
  russianCitizenshipConfirmed: boolean;
  createdAt: string;
};

export type SpecialDrawWinner = SpecialParticipant & {
  position: number;
  selectedTicket: number;
  ticketRangeStart: number;
  ticketRangeEnd: number;
  showingWeightNumerator: number;
  showingWeightDenominator: number;
  drawWeight: number;
  poolWeightBeforeDraw: number;
  randomSource: string;
};

export type SpecialDrawTicketRange = {
  applicationId: number;
  applicationCode: string;
  baseScore?: number;
  socialBonusPoints?: number;
  score: number;
  selectedShowingCount: number;
  previousSpecialWinner?: boolean;
  previousWinnerWeightPercent?: number;
  showingWeightNumerator: number;
  showingWeightDenominator: number;
  drawWeight: number;
  ticketRangeStart: number;
  ticketRangeEnd: number;
};

export type SpecialDrawAuditEntry = {
  position: number;
  totalTickets: number;
  selectedTicket: number;
  winnerApplicationId: number;
  winnerApplicationCode: string;
  ticketRanges: SpecialDrawTicketRange[];
  randomSource: string;
};

export type SpecialDrawResult = {
  id: number;
  runType: SpecialDrawRunType;
  createdAt: string;
  event: SpecialEventRow;
  showing: SpecialShowingRow;
  totalCandidates: number;
  totalWeight: number;
  winners: SpecialDrawWinner[];
  candidates: SpecialParticipant[];
  drawMechanism: {
    algorithm: 'weighted_ticket_draw_without_replacement' | 'distributed_weighted_ticket_draw_without_replacement';
    ticketRule: '1_score_point_equals_1_ticket' | 'score_divided_by_selected_showing_count';
    weightScale?: number;
    randomSource: string;
    audit: SpecialDrawAuditEntry[];
  };
};

function formatKaliningradDateTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Kaliningrad',
  }).format(new Date(value));
}

function maskEmail(email: string) {
  const [local, domain = ''] = email.split('@');
  const safeLocal = local.length <= 2 ? `${local[0] ?? '*'}*` : `${local.slice(0, 2)}***`;
  const [domainName, domainZone = ''] = domain.split('.');
  const safeDomain = domainName.length <= 2 ? `${domainName[0] ?? '*'}*` : `${domainName.slice(0, 2)}***`;
  return `${safeLocal}@${safeDomain}${domainZone ? `.${domainZone}` : ''}`;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/u, '$1 $2 ***-**-$5');
}

function getEventById(db: Database.Database, eventId: number) {
  return db.prepare(`
    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent,
      auto_draw_lead_hours, requires_russian_citizenship, winner_email_enabled, winner_response_deadline_hours
    FROM special_events
    WHERE id = ?
    LIMIT 1
  `).get(eventId) as SpecialEventRow | undefined;
}

function getShowingById(db: Database.Database, showingId: number) {
  return db.prepare(`
    SELECT *
    FROM special_event_showings
    WHERE id = ?
    LIMIT 1
  `).get(showingId) as SpecialShowingRow | undefined;
}

function listShowingsForEvent(db: Database.Database, eventId: number) {
  return db.prepare(`
    SELECT *
    FROM special_event_showings
    WHERE special_event_id = ?
    ORDER BY starts_at ASC, id ASC
  `).all(eventId) as SpecialShowingRow[];
}

function parseResultWinners(row: SpecialDrawRunRow | undefined) {
  if (!row) {
    return [] as Array<{ applicationId: number; participantProfileId: number | null }>;
  }

  try {
    const result = JSON.parse(row.result_json) as {
      winners?: Array<{ applicationId?: number; participantProfileId?: number | null }>;
    };
    return (result.winners ?? []).flatMap((winner) => {
      if (!winner.applicationId) {
        return [];
      }
      return [{
        applicationId: winner.applicationId,
        participantProfileId: winner.participantProfileId ?? null,
      }];
    });
  } catch {
    return [];
  }
}

function countSelectedShowings(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function normalizeSelectedShowingCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : 1;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(Math.trunc(a));
  let right = Math.abs(Math.trunc(b));
  while (right > 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function leastCommonMultiple(a: number, b: number) {
  return Math.abs(Math.trunc(a * b)) / greatestCommonDivisor(a, b);
}

function normalizeWeightPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.min(100, Math.max(0, Math.trunc(value)));
}

function getWeightPercentDenominator(value: number) {
  const percent = normalizeWeightPercent(value);
  if (percent <= 0 || percent >= 100) {
    return 1;
  }
  return 100 / greatestCommonDivisor(percent, 100);
}

function computeWeightScale(candidates: SpecialParticipant[]) {
  return candidates.reduce((scale, candidate) => {
    const dateScale = normalizeSelectedShowingCount(candidate.selectedShowingCount);
    const percentScale = getWeightPercentDenominator(candidate.previousWinnerWeightPercent);
    return leastCommonMultiple(leastCommonMultiple(scale, dateScale), percentScale);
  }, 1);
}

function getDistributedDrawWeight(candidate: Pick<SpecialParticipant, 'score' | 'selectedShowingCount'>, weightScale: number) {
  const selectedShowingCount = normalizeSelectedShowingCount(candidate.selectedShowingCount);
  const previousWinnerWeightPercent = 'previousWinnerWeightPercent' in candidate
    ? normalizeWeightPercent(Number(candidate.previousWinnerWeightPercent))
    : 100;
  return Math.max(0, Math.trunc(candidate.score * (weightScale / selectedShowingCount) * previousWinnerWeightPercent / 100));
}

function formatShowingWeight(score: number, selectedShowingCount: number) {
  const denominator = normalizeSelectedShowingCount(selectedShowingCount);
  if (denominator === 1) {
    return String(score);
  }
  if (score % denominator === 0) {
    return String(score / denominator);
  }
  return `${score}/${denominator}`;
}

function formatScoreBreakdown(participant: Pick<SpecialParticipant, 'score' | 'baseScore' | 'socialBonusPoints'>) {
  if (participant.socialBonusPoints <= 0) {
    return String(participant.score);
  }
  return `${participant.score} (основные ${participant.baseScore} + соцбаллы ${participant.socialBonusPoints})`;
}

function getLatestDrawRow(db: Database.Database, showingId: number, runType?: SpecialDrawRunType) {
  const whereRunType = runType ? 'AND run_type = ?' : '';
  const params = runType ? [showingId, runType] : [showingId];
  return db.prepare(`
    SELECT *
    FROM special_draw_runs
    WHERE showing_id = ?
    ${whereRunType}
    ORDER BY id DESC
    LIMIT 1
  `).get(...params) as SpecialDrawRunRow | undefined;
}

export function listSpecialShowingsDueForAutoDraw(
  db: Database.Database,
  now = new Date(),
) {
  const rows = db.prepare(`
    SELECT
      e.id AS event_id,
      e.slug AS event_slug,
      e.title AS event_title,
      e.format_label AS event_format_label,
      e.venue_name AS event_venue_name,
      e.previous_winner_weight_percent AS event_previous_winner_weight_percent,
      e.auto_draw_lead_hours AS event_auto_draw_lead_hours,
      e.requires_russian_citizenship AS event_requires_russian_citizenship,
      e.winner_email_enabled AS event_winner_email_enabled,
      e.winner_response_deadline_hours AS event_winner_response_deadline_hours,
      s.id AS showing_id,
      s.special_event_id AS showing_special_event_id,
      s.slug AS showing_slug,
      s.starts_at AS showing_starts_at,
      s.display_label AS showing_display_label,
      s.time_is_final AS showing_time_is_final,
      s.physical_quota AS showing_physical_quota,
      s.reserved_seats AS showing_reserved_seats,
      s.lottery_quota AS showing_lottery_quota,
      s.draw_status AS showing_draw_status
    FROM special_event_showings s
    INNER JOIN special_events e ON e.id = s.special_event_id
    WHERE s.draw_status NOT IN ('published', 'final')
      AND s.lottery_quota > 0
      AND datetime(?) >= datetime(s.starts_at, printf('-%d hours', e.auto_draw_lead_hours))
      AND datetime(?) < datetime(s.starts_at)
      AND NOT EXISTS (
        SELECT 1
        FROM special_draw_runs dr
        WHERE dr.showing_id = s.id
          AND dr.run_type = 'published'
      )
    ORDER BY s.starts_at ASC, s.id ASC
  `).all(now.toISOString(), now.toISOString()) as Array<{
    event_id: number;
    event_slug: string;
    event_title: string;
    event_format_label: string;
    event_venue_name: string;
    event_previous_winner_weight_percent: number;
    event_auto_draw_lead_hours: number;
    event_requires_russian_citizenship: number;
    event_winner_email_enabled: number;
    event_winner_response_deadline_hours: number;
    showing_id: number;
    showing_special_event_id: number;
    showing_slug: string;
    showing_starts_at: string;
    showing_display_label: string;
    showing_time_is_final: number;
    showing_physical_quota: number;
    showing_reserved_seats: number;
    showing_lottery_quota: number;
    showing_draw_status: string;
  }>;

  return rows.map((row) => ({
    event: {
      id: row.event_id,
      slug: row.event_slug,
      title: row.event_title,
      format_label: row.event_format_label,
      venue_name: row.event_venue_name,
      previous_winner_weight_percent: row.event_previous_winner_weight_percent,
      auto_draw_lead_hours: row.event_auto_draw_lead_hours,
      requires_russian_citizenship: row.event_requires_russian_citizenship,
      winner_email_enabled: row.event_winner_email_enabled,
      winner_response_deadline_hours: row.event_winner_response_deadline_hours,
    },
    showing: {
      id: row.showing_id,
      special_event_id: row.showing_special_event_id,
      slug: row.showing_slug,
      starts_at: row.showing_starts_at,
      display_label: row.showing_display_label,
      time_is_final: row.showing_time_is_final,
      physical_quota: row.showing_physical_quota,
      reserved_seats: row.showing_reserved_seats,
      lottery_quota: row.showing_lottery_quota,
      draw_status: row.showing_draw_status,
    },
    autoPublishAt: new Date(
      new Date(row.showing_starts_at).getTime() - row.event_auto_draw_lead_hours * 60 * 60 * 1000,
    ).toISOString(),
  } satisfies SpecialAutoDrawDueShowing));
}

function getPublishedWinnerProfileIds(
  db: Database.Database,
  currentShowingId: number,
  currentSpecialEventId: number,
  scope: 'same_event' | 'other_events',
) {
  const rows = db.prepare(`
    SELECT dr.*
    FROM special_draw_runs dr
    INNER JOIN special_event_showings s ON s.id = dr.showing_id
    WHERE dr.showing_id != ?
      AND s.special_event_id ${scope === 'same_event' ? '=' : '!='} ?
      AND dr.run_type = 'published'
    ORDER BY dr.id ASC
  `).all(currentShowingId, currentSpecialEventId) as SpecialDrawRunRow[];

  const ids = new Set<number>();
  for (const row of rows) {
    for (const winner of parseResultWinners(row)) {
      if (winner.participantProfileId) {
        ids.add(winner.participantProfileId);
      }
    }
  }

  return ids;
}

function listCandidateRows(
  db: Database.Database,
  showing: SpecialShowingRow,
) {
  const event = getEventById(db, showing.special_event_id);
  if (!event) {
    return [];
  }

  const sameEventWinnerProfileIds = getPublishedWinnerProfileIds(
    db,
    showing.id,
    showing.special_event_id,
    'same_event',
  );
  const otherEventWinnerProfileIds = getPublishedWinnerProfileIds(
    db,
    showing.id,
    showing.special_event_id,
    'other_events',
  );
  const rows = db.prepare(`
    SELECT a.*
    FROM special_applications a
    INNER JOIN special_application_showings aps ON aps.application_id = a.id
    WHERE aps.showing_id = ?
      AND a.status = 'accepted'
      AND a.score > 0
      AND a.application_code NOT LIKE 'TEST-%'
    ORDER BY a.created_at ASC, a.id ASC
  `).all(showing.id) as SpecialApplicationRow[];

  return rows.flatMap((row) => {
    if (row.participant_profile_id && sameEventWinnerProfileIds.has(row.participant_profile_id)) {
      return [];
    }

    const previousSpecialWinner = Boolean(
      row.participant_profile_id && otherEventWinnerProfileIds.has(row.participant_profile_id),
    );
    if (previousSpecialWinner && event.previous_winner_weight_percent <= 0) {
      return [];
    }

    return [{
      ...row,
      previous_special_winner: previousSpecialWinner ? 1 : 0,
      previous_winner_weight_percent: previousSpecialWinner ? event.previous_winner_weight_percent : 100,
    } satisfies SpecialCandidateRow];
  });
}

function emptySocialBonus(applicationId: number): SocialRaffleBonus {
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

function loadBonusesForRows(db: Database.Database, rows: Array<Pick<SpecialCandidateRow, 'id'>>) {
  return loadSocialRaffleBonuses(db, rows.map((row) => row.id));
}

function mapParticipants(
  rows: SpecialCandidateRow[],
  privateKeyPemBase64: string,
  socialBonuses: Map<number, SocialRaffleBonus> = new Map(),
) {
  return rows.flatMap((row) => {
    try {
      const pii = decryptPii(privateKeyPemBase64, {
        piiCiphertext: row.pii_ciphertext,
        piiWrappedKey: row.pii_wrapped_key,
        piiIv: row.pii_iv,
        piiAlg: row.pii_alg,
      });
      const socialBonus = socialBonuses.get(row.id) ?? emptySocialBonus(row.id);
      const baseScore = Math.max(0, Math.trunc(Number(row.score) || 0));
      const socialBonusPoints = Math.max(0, Math.trunc(Number(socialBonus.bonusPoints) || 0));
      const effectiveScore = baseScore + socialBonusPoints;

      return [{
        applicationId: row.id,
        applicationCode: row.application_code,
        participantProfileId: row.participant_profile_id,
        fullName: pii.fullName ?? '',
        email: pii.email ?? '',
        phone: pii.phone ?? '',
        status: row.status,
        baseScore,
        socialBonusPoints,
        socialBonusRawPoints: Number(socialBonus.rawPoints) || 0,
        socialBonusActiveDays: Math.max(0, Math.trunc(Number(socialBonus.activeDays) || 0)),
        socialBonusEligibleActivityCount: Math.max(0, Math.trunc(Number(socialBonus.eligibleActivityCount) || 0)),
        socialBonusLatestActivityAt: socialBonus.latestActivityAt,
        score: effectiveScore,
        stampCount: row.stamp_count,
        ordinaryRegistrationCount: row.ordinary_registration_count,
        noShowCount: row.no_show_count,
        uploadedPhotoCount: row.uploaded_photo_count,
        uniquePhotoCount: row.unique_photo_count,
        acceptedPhotoCount: row.accepted_photo_count,
        selectedShowingCount: countSelectedShowings(row.selected_showing_ids_json),
        previousSpecialWinner: Boolean(row.previous_special_winner),
        previousWinnerWeightPercent: row.previous_winner_weight_percent,
        russianCitizenshipConfirmed: Boolean(row.russian_citizenship_confirmed),
        createdAt: row.created_at,
      } satisfies SpecialParticipant];
    } catch {
      return [];
    }
  });
}

function weightedDraw(candidates: SpecialParticipant[], limit: number) {
  const pool = candidates.map((candidate) => ({ ...candidate }));
  const winners: SpecialDrawWinner[] = [];
  const audit: SpecialDrawAuditEntry[] = [];
  const randomSource = 'node:crypto.randomInt';
  const weightScale = computeWeightScale(candidates);

  while (pool.length && winners.length < limit) {
    const totalWeight = pool.reduce((sum, candidate) => sum + getDistributedDrawWeight(candidate, weightScale), 0);
    if (totalWeight <= 0) {
      break;
    }

    const selectedTicket = crypto.randomInt(totalWeight) + 1;
    let target = selectedTicket;
    let winnerIndex = -1;
    let ticketCursor = 1;
    const ticketRanges: SpecialDrawTicketRange[] = [];
    for (const [index, candidate] of pool.entries()) {
      const selectedShowingCount = normalizeSelectedShowingCount(candidate.selectedShowingCount);
      const drawWeight = getDistributedDrawWeight(candidate, weightScale);
      const ticketRangeStart = ticketCursor;
      const ticketRangeEnd = ticketCursor + drawWeight - 1;
      ticketRanges.push({
        applicationId: candidate.applicationId,
        applicationCode: candidate.applicationCode,
        baseScore: candidate.baseScore,
        socialBonusPoints: candidate.socialBonusPoints,
        score: candidate.score,
        selectedShowingCount,
        previousSpecialWinner: candidate.previousSpecialWinner,
        previousWinnerWeightPercent: candidate.previousWinnerWeightPercent,
        showingWeightNumerator: candidate.score,
        showingWeightDenominator: selectedShowingCount,
        drawWeight,
        ticketRangeStart,
        ticketRangeEnd,
      });

      target -= drawWeight;
      if (winnerIndex === -1 && target <= 0) {
        winnerIndex = index;
      }
      ticketCursor = ticketRangeEnd + 1;
    }

    const [winner] = pool.splice(Math.max(winnerIndex, 0), 1);
    const winnerRange = ticketRanges.find((range) => range.applicationId === winner.applicationId);
    const position = winners.length + 1;
    winners.push({
      ...winner,
      position,
      selectedTicket,
      ticketRangeStart: winnerRange?.ticketRangeStart ?? selectedTicket,
      ticketRangeEnd: winnerRange?.ticketRangeEnd ?? selectedTicket,
      showingWeightNumerator: winnerRange?.showingWeightNumerator ?? winner.score,
      showingWeightDenominator: winnerRange?.showingWeightDenominator ?? normalizeSelectedShowingCount(winner.selectedShowingCount),
      drawWeight: winnerRange?.drawWeight ?? getDistributedDrawWeight(winner, weightScale),
      poolWeightBeforeDraw: totalWeight,
      randomSource,
    });
    audit.push({
      position,
      totalTickets: totalWeight,
      selectedTicket,
      winnerApplicationId: winner.applicationId,
      winnerApplicationCode: winner.applicationCode,
      ticketRanges,
      randomSource,
    });
  }

  return { winners, audit, randomSource, weightScale };
}

function snapshotParticipant(participant: SpecialParticipant) {
  return {
    applicationId: participant.applicationId,
    applicationCode: participant.applicationCode,
    participantProfileId: participant.participantProfileId,
    score: participant.score,
    baseScore: participant.baseScore,
    socialBonusPoints: participant.socialBonusPoints,
    socialBonusRawPoints: participant.socialBonusRawPoints,
    socialBonusActiveDays: participant.socialBonusActiveDays,
    socialBonusEligibleActivityCount: participant.socialBonusEligibleActivityCount,
    socialBonusLatestActivityAt: participant.socialBonusLatestActivityAt,
    stampCount: participant.stampCount,
    ordinaryRegistrationCount: participant.ordinaryRegistrationCount,
    noShowCount: participant.noShowCount,
    uploadedPhotoCount: participant.uploadedPhotoCount,
    uniquePhotoCount: participant.uniquePhotoCount,
    acceptedPhotoCount: participant.acceptedPhotoCount,
    selectedShowingCount: participant.selectedShowingCount,
    previousSpecialWinner: participant.previousSpecialWinner,
    previousWinnerWeightPercent: participant.previousWinnerWeightPercent,
    russianCitizenshipConfirmed: participant.russianCitizenshipConfirmed,
    createdAt: participant.createdAt,
  };
}

function rowToDrawResult(
  row: SpecialDrawRunRow,
  event: SpecialEventRow,
  showing: SpecialShowingRow,
  candidates: SpecialParticipant[],
) {
  const result = JSON.parse(row.result_json) as {
    totalCandidates: number;
    totalWeight: number;
    winners: Array<{
      applicationId: number;
      position: number;
      selectedTicket?: number;
      ticketRangeStart?: number;
      ticketRangeEnd?: number;
      showingWeightNumerator?: number;
      showingWeightDenominator?: number;
      drawWeight?: number;
      poolWeightBeforeDraw?: number;
      randomSource?: string;
    }>;
    drawMechanism?: SpecialDrawResult['drawMechanism'];
  };
  const byId = new Map(candidates.map((candidate) => [candidate.applicationId, candidate]));
  const winners = result.winners.flatMap((winner) => {
    const participant = byId.get(winner.applicationId);
    return participant ? [{
      ...participant,
      position: winner.position,
      selectedTicket: winner.selectedTicket ?? 0,
      ticketRangeStart: winner.ticketRangeStart ?? 0,
      ticketRangeEnd: winner.ticketRangeEnd ?? 0,
      showingWeightNumerator: winner.showingWeightNumerator ?? participant.score,
      showingWeightDenominator: winner.showingWeightDenominator ?? normalizeSelectedShowingCount(participant.selectedShowingCount),
      drawWeight: winner.drawWeight ?? getDistributedDrawWeight(participant, result.drawMechanism?.weightScale ?? 1),
      poolWeightBeforeDraw: winner.poolWeightBeforeDraw ?? result.totalWeight,
      randomSource: winner.randomSource ?? result.drawMechanism?.randomSource ?? 'node:crypto.randomInt',
    }] : [];
  });

  return {
    id: row.id,
    runType: row.run_type,
    createdAt: row.created_at,
    event,
    showing,
    totalCandidates: result.totalCandidates,
    totalWeight: result.totalWeight,
    winners,
    candidates,
    drawMechanism: result.drawMechanism ?? {
      algorithm: 'weighted_ticket_draw_without_replacement',
      ticketRule: '1_score_point_equals_1_ticket',
      randomSource: 'node:crypto.randomInt',
      audit: [],
    },
  } satisfies SpecialDrawResult;
}

export function listSpecialEventsForTelegram(db: Database.Database) {
  const events = db.prepare(`
    SELECT id, slug, title, format_label, venue_name, previous_winner_weight_percent,
      auto_draw_lead_hours, requires_russian_citizenship, winner_email_enabled, winner_response_deadline_hours
    FROM special_events
    ORDER BY created_at ASC, id ASC
  `).all() as SpecialEventRow[];

  return events.map((event) => {
    const showings = listShowingsForEvent(db, event.id).map((showing) => {
      const acceptedCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM special_applications a
        INNER JOIN special_application_showings aps ON aps.application_id = a.id
        WHERE aps.showing_id = ?
          AND a.status = 'accepted'
          AND a.score > 0
          AND a.application_code NOT LIKE 'TEST-%'
      `).get(showing.id) as { count: number };
      const latestPublished = getLatestDrawRow(db, showing.id, 'published');
      return {
        ...showing,
        acceptedApplicationCount: acceptedCount.count,
        latestPublishedWinnerCount: parseResultWinners(latestPublished).length,
      };
    });

    return { event, showings };
  });
}

export function getSpecialEventForTelegram(db: Database.Database, eventId: number) {
  const event = getEventById(db, eventId);
  if (!event) {
    return null;
  }

  const showings = listShowingsForEvent(db, event.id);
  return { event, showings };
}

export function getSpecialShowingForTelegram(
  db: Database.Database,
  showingId: number,
  privateKeyPemBase64?: string | null,
) {
  const showing = getShowingById(db, showingId);
  if (!showing) {
    return null;
  }

  const event = getEventById(db, showing.special_event_id);
  if (!event) {
    return null;
  }

  const acceptedRows = listCandidateRows(db, showing);
  const candidates = privateKeyPemBase64
    ? mapParticipants(acceptedRows, privateKeyPemBase64, loadBonusesForRows(db, acceptedRows))
    : [];
  const latestDraft = getLatestDrawRow(db, showing.id, 'draft');
  const latestPublished = getLatestDrawRow(db, showing.id, 'published');

  return {
    event,
    showing,
    acceptedApplicationCount: acceptedRows.length,
    eligibleApplicationCount: candidates.length,
    candidates,
    latestDraft,
    latestPublished,
    latestPublishedWinners: parseResultWinners(latestPublished),
  };
}

export function runSpecialDraw(
  db: Database.Database,
  showingId: number,
  runType: SpecialDrawRunType,
  privateKeyPemBase64: string,
) {
  const showing = getShowingById(db, showingId);
  if (!showing) {
    throw new Error('special_showing_not_found');
  }

  const event = getEventById(db, showing.special_event_id);
  if (!event) {
    throw new Error('special_event_not_found');
  }

  const candidateRows = listCandidateRows(db, showing);
  const candidates = mapParticipants(candidateRows, privateKeyPemBase64, loadBonusesForRows(db, candidateRows));
  const draw = weightedDraw(candidates, showing.lottery_quota);
  const winners = draw.winners;
  const totalWeight = candidates.reduce((sum, candidate) => sum + getDistributedDrawWeight(candidate, draw.weightScale), 0);
  const snapshot = {
    createdAt: new Date().toISOString(),
    eventId: event.id,
    eventSlug: event.slug,
    showingId: showing.id,
    showingSlug: showing.slug,
    runType,
    participants: candidates.map(snapshotParticipant),
  };
  const result = {
    totalCandidates: candidates.length,
    totalWeight,
    quota: showing.lottery_quota,
    drawMechanism: {
      algorithm: 'distributed_weighted_ticket_draw_without_replacement',
      ticketRule: 'score_divided_by_selected_showing_count',
      weightScale: draw.weightScale,
      randomSource: draw.randomSource,
      audit: draw.audit,
    } as const,
    winners: winners.map((winner) => ({
      position: winner.position,
      applicationId: winner.applicationId,
      applicationCode: winner.applicationCode,
      participantProfileId: winner.participantProfileId,
      baseScore: winner.baseScore,
      socialBonusPoints: winner.socialBonusPoints,
      socialBonusRawPoints: winner.socialBonusRawPoints,
      socialBonusActiveDays: winner.socialBonusActiveDays,
      socialBonusEligibleActivityCount: winner.socialBonusEligibleActivityCount,
      socialBonusLatestActivityAt: winner.socialBonusLatestActivityAt,
      score: winner.score,
      stampCount: winner.stampCount,
      noShowCount: winner.noShowCount,
      previousSpecialWinner: winner.previousSpecialWinner,
      previousWinnerWeightPercent: winner.previousWinnerWeightPercent,
      selectedTicket: winner.selectedTicket,
      ticketRangeStart: winner.ticketRangeStart,
      ticketRangeEnd: winner.ticketRangeEnd,
      showingWeightNumerator: winner.showingWeightNumerator,
      showingWeightDenominator: winner.showingWeightDenominator,
      drawWeight: winner.drawWeight,
      poolWeightBeforeDraw: winner.poolWeightBeforeDraw,
      randomSource: winner.randomSource,
    })),
  };

  const inserted = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO special_draw_runs(showing_id, run_type, snapshot_json, result_json)
      VALUES (?, ?, ?, ?)
    `).run(showing.id, runType, JSON.stringify(snapshot), JSON.stringify(result));

    db.prepare(`
      UPDATE special_event_showings
      SET draw_status = ?,
          updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ?
    `).run(runType, showing.id);

    return Number(info.lastInsertRowid);
  })();

  return {
    id: inserted,
    runType,
    createdAt: new Date().toISOString(),
    event,
    showing,
    totalCandidates: candidates.length,
    totalWeight,
    winners,
    candidates,
    drawMechanism: result.drawMechanism,
  } satisfies SpecialDrawResult;
}

export function getLatestSpecialDrawResult(
  db: Database.Database,
  showingId: number,
  runType: SpecialDrawRunType,
  privateKeyPemBase64: string,
) {
  const showing = getShowingById(db, showingId);
  if (!showing) {
    return null;
  }

  const event = getEventById(db, showing.special_event_id);
  const row = getLatestDrawRow(db, showing.id, runType);
  if (!event || !row) {
    return null;
  }

  const otherEventWinnerProfileIds = getPublishedWinnerProfileIds(
    db,
    showing.id,
    showing.special_event_id,
    'other_events',
  );
  const allRows = db.prepare(`
    SELECT a.*
    FROM special_applications a
    INNER JOIN special_application_showings aps ON aps.application_id = a.id
    WHERE aps.showing_id = ?
    ORDER BY a.created_at ASC, a.id ASC
  `).all(showing.id) as SpecialApplicationRow[];
  const decoratedRows = allRows.map((application) => {
    const previousSpecialWinner = Boolean(
      application.participant_profile_id && otherEventWinnerProfileIds.has(application.participant_profile_id),
    );
    return {
      ...application,
      previous_special_winner: previousSpecialWinner ? 1 : 0,
      previous_winner_weight_percent: previousSpecialWinner ? event.previous_winner_weight_percent : 100,
    } satisfies SpecialCandidateRow;
  });

  return rowToDrawResult(row, event, showing, mapParticipants(decoratedRows, privateKeyPemBase64, loadBonusesForRows(db, decoratedRows)));
}

export function listSpecialApplicationPhotos(db: Database.Database, applicationId: number) {
  return db.prepare(`
    SELECT *
    FROM special_application_photos
    WHERE application_id = ?
    ORDER BY id ASC
  `).all(applicationId) as SpecialPhotoRow[];
}

export function formatSpecialEventsPanel(items: ReturnType<typeof listSpecialEventsForTelegram>) {
  if (!items.length) {
    return 'Спецмероприятия пока не заведены.';
  }

  return [
    'Спецмероприятия',
    '',
    ...items.map(({ event, showings }, index) => [
      `${index + 1}. ${event.title}`,
      `${event.format_label}, ${event.venue_name}`,
      `Показов: ${showings.length}`,
      `Допущенных заявок: ${showings.reduce((sum, showing) => sum + showing.acceptedApplicationCount, 0)}`,
    ].join('\n')),
  ].join('\n\n');
}

export function formatSpecialEventPanel(item: NonNullable<ReturnType<typeof getSpecialEventForTelegram>>) {
  return [
    item.event.title,
    `${item.event.format_label}, ${item.event.venue_name}`,
    '',
    'Показы:',
    ...item.showings.map((showing, index) => `${index + 1}. ${showing.display_label} — ${showing.lottery_quota} мест, статус розыгрыша: ${showing.draw_status}`),
  ].join('\n');
}

export function formatSpecialShowingPanel(item: NonNullable<ReturnType<typeof getSpecialShowingForTelegram>>) {
  return [
    item.event.title,
    item.showing.display_label,
    '',
    `Физическая квота: ${item.showing.physical_quota}`,
    `Бронь: ${item.showing.reserved_seats}`,
    `Мест в розыгрыше: ${item.showing.lottery_quota}`,
    `Допущенных заявок: ${item.acceptedApplicationCount}`,
    `Статус розыгрыша: ${item.showing.draw_status}`,
    item.latestDraft ? `Последний черновик: ${formatKaliningradDateTime(item.latestDraft.created_at)}` : 'Последний черновик: нет',
    item.latestPublished
      ? `Опубликовано: ${formatKaliningradDateTime(item.latestPublished.created_at)}, победителей: ${item.latestPublishedWinners.length}`
      : 'Опубликовано: нет',
  ].join('\n');
}

export function formatSpecialShowingApplicants(item: NonNullable<ReturnType<typeof getSpecialShowingForTelegram>>) {
  const weightScale = computeWeightScale(item.candidates);
  const header = [
    'Заявители до розыгрыша',
    item.event.title,
    item.showing.display_label,
    '',
    `Допущенных заявок: ${item.candidates.length}`,
  ];

  if (!item.candidates.length) {
    return [...header, '', 'Пока нет допущенных заявок для этого показа.'].join('\n');
  }

  const lines = item.candidates.slice(0, 40).map((candidate, index) => [
    `${index + 1}. ФИО: ${candidate.fullName}`,
    `   Баллы для розыгрыша: ${formatScoreBreakdown(candidate)}, штампы: ${candidate.stampCount}, неявки: ${candidate.noShowCount}`,
    candidate.socialBonusPoints > 0
      ? `   Соцактивность VK: +${candidate.socialBonusPoints} балл., активных дней ${candidate.socialBonusActiveDays}, действий ${candidate.socialBonusEligibleActivityCount}`
      : null,
    `   Фото: ${candidate.acceptedPhotoCount}/${candidate.uniquePhotoCount}/${candidate.uploadedPhotoCount}`,
    `   Выбрано дат: ${candidate.selectedShowingCount}, вес на этот показ: ${formatShowingWeight(candidate.score, candidate.selectedShowingCount)} (${getDistributedDrawWeight(candidate, weightScale)} тех. билетиков)`,
    candidate.previousSpecialWinner ? `   Уже выигрывал спецрозыгрыш: да, коэффициент веса ${candidate.previousWinnerWeightPercent}%` : null,
    `   Код заявки: ${candidate.applicationCode}`,
  ].filter(Boolean).join('\n'));

  if (item.candidates.length > 40) {
    lines.push(`… и ещё ${item.candidates.length - 40} заявителей.`);
  }

  return [...header, '', ...lines].join('\n');
}

export function formatSpecialDrawResult(result: SpecialDrawResult) {
  const header = [
    `${result.runType === 'draft' ? 'Черновой розыгрыш' : 'Опубликованный розыгрыш'}`,
    result.event.title,
    result.showing.display_label,
    '',
    `Кандидатов: ${result.totalCandidates}`,
    `Технических билетиков в барабане: ${result.totalWeight}`,
    `Победителей: ${result.winners.length} из ${result.showing.lottery_quota}`,
    result.drawMechanism.ticketRule === 'score_divided_by_selected_showing_count'
      ? 'Механика: баллы участника делятся между выбранными датами; на этом показе вес = баллы / количество выбранных дат.'
      : 'Механика: 1 балл = 1 билет; выбирается один случайный номер билета в раунде.',
    result.drawMechanism.weightScale ? `Технический масштаб весов: ${result.drawMechanism.weightScale}` : null,
    `Источник случайности: ${result.drawMechanism.randomSource}`,
    '',
  ].filter((item): item is string => Boolean(item));

  if (!result.winners.length) {
    return [...header, 'Победителей нет: недостаточно допущенных заявок.'].join('\n');
  }

  const winners = result.winners.slice(0, 30).map((winner) => [
    `${winner.position}. ${winner.fullName}`,
    `   Баллы для розыгрыша: ${formatScoreBreakdown(winner)}, штампы: ${winner.stampCount}, неявки: ${winner.noShowCount}`,
    winner.socialBonusPoints > 0
      ? `   Соцактивность VK: +${winner.socialBonusPoints} балл., активных дней ${winner.socialBonusActiveDays}, действий ${winner.socialBonusEligibleActivityCount}`
      : null,
    `   Выбрано дат: ${winner.selectedShowingCount}, вес на этот показ: ${formatShowingWeight(winner.showingWeightNumerator, winner.showingWeightDenominator)} (${winner.drawWeight} тех. билетиков)`,
    winner.previousSpecialWinner ? `   Уже выигрывал спецрозыгрыш: да, коэффициент веса ${winner.previousWinnerWeightPercent}%` : null,
    `   Раунд: выпал билет №${winner.selectedTicket} из ${winner.poolWeightBeforeDraw}`,
    `   Билетики участника в раунде: №${winner.ticketRangeStart}–${winner.ticketRangeEnd}`,
    `   ${maskEmail(winner.email)}, ${maskPhone(winner.phone)}`,
    `   Код заявки: ${winner.applicationCode}`,
  ].filter(Boolean).join('\n'));

  if (result.winners.length > 30) {
    winners.push(`… и ещё ${result.winners.length - 30} победителей.`);
  }

  return [...header, ...winners].join('\n');
}

export async function buildSpecialDrawXlsxBuffer(result: SpecialDrawResult) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'registration-service';
  workbook.created = new Date();

  const winnersSheet = workbook.addWorksheet('Победители');
  winnersSheet.columns = [
    { header: 'Место', key: 'position', width: 10 },
    { header: 'ФИО', key: 'fullName', width: 34 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Телефон', key: 'phone', width: 20 },
    { header: 'Код заявки', key: 'applicationCode', width: 42 },
    { header: 'Баллы всего', key: 'score', width: 12 },
    { header: 'Основные баллы', key: 'baseScore', width: 14 },
    { header: 'Соцбаллы VK', key: 'socialBonusPoints', width: 14 },
    { header: 'Сырые соцбаллы VK', key: 'socialBonusRawPoints', width: 18 },
    { header: 'VK активных дней', key: 'socialBonusActiveDays', width: 18 },
    { header: 'VK действий', key: 'socialBonusEligibleActivityCount', width: 14 },
    { header: 'Последняя VK активность', key: 'socialBonusLatestActivityAt', width: 24 },
    { header: 'Выбрано дат', key: 'selectedShowingCount', width: 14 },
    { header: 'Вес на показ', key: 'showingWeight', width: 18 },
    { header: 'Тех. билетики участника', key: 'drawWeight', width: 22 },
    { header: 'Выигрывал спецрозыгрыш', key: 'previousSpecialWinner', width: 24 },
    { header: 'Коэффициент веса', key: 'previousWinnerWeightPercent', width: 20 },
    { header: 'Выпавший билет', key: 'selectedTicket', width: 18 },
    { header: 'Всего тех. билетиков в раунде', key: 'poolWeightBeforeDraw', width: 30 },
    { header: 'Диапазон билетов победителя', key: 'ticketRange', width: 30 },
    { header: 'Источник случайности', key: 'randomSource', width: 28 },
    { header: 'Штампы', key: 'stampCount', width: 10 },
    { header: 'Неявки', key: 'noShowCount', width: 10 },
    { header: 'Дата заявки', key: 'createdAt', width: 28 },
  ];

  for (const winner of result.winners) {
    winnersSheet.addRow({
      position: winner.position,
      fullName: winner.fullName,
      email: winner.email,
      phone: winner.phone,
      applicationCode: winner.applicationCode,
      score: winner.score,
      baseScore: winner.baseScore,
      socialBonusPoints: winner.socialBonusPoints,
      socialBonusRawPoints: winner.socialBonusRawPoints,
      socialBonusActiveDays: winner.socialBonusActiveDays,
      socialBonusEligibleActivityCount: winner.socialBonusEligibleActivityCount,
      socialBonusLatestActivityAt: winner.socialBonusLatestActivityAt ?? '',
      selectedShowingCount: winner.selectedShowingCount,
      showingWeight: formatShowingWeight(winner.showingWeightNumerator, winner.showingWeightDenominator),
      drawWeight: winner.drawWeight,
      previousSpecialWinner: winner.previousSpecialWinner ? 'да' : '',
      previousWinnerWeightPercent: `${winner.previousWinnerWeightPercent}%`,
      selectedTicket: winner.selectedTicket,
      poolWeightBeforeDraw: winner.poolWeightBeforeDraw,
      ticketRange: `№${winner.ticketRangeStart}–№${winner.ticketRangeEnd}`,
      randomSource: winner.randomSource,
      stampCount: winner.stampCount,
      noShowCount: winner.noShowCount,
      createdAt: formatKaliningradDateTime(winner.createdAt),
    });
  }

  const candidatesSheet = workbook.addWorksheet('Кандидаты');
  candidatesSheet.columns = [
    { header: 'ФИО', key: 'fullName', width: 34 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Телефон', key: 'phone', width: 20 },
    { header: 'Код заявки', key: 'applicationCode', width: 42 },
    { header: 'Баллы всего', key: 'score', width: 12 },
    { header: 'Основные баллы', key: 'baseScore', width: 14 },
    { header: 'Соцбаллы VK', key: 'socialBonusPoints', width: 14 },
    { header: 'Сырые соцбаллы VK', key: 'socialBonusRawPoints', width: 18 },
    { header: 'VK активных дней', key: 'socialBonusActiveDays', width: 18 },
    { header: 'VK действий', key: 'socialBonusEligibleActivityCount', width: 14 },
    { header: 'Последняя VK активность', key: 'socialBonusLatestActivityAt', width: 24 },
    { header: 'Выбрано дат', key: 'selectedShowingCount', width: 14 },
    { header: 'Вес на этот показ', key: 'showingWeight', width: 18 },
    { header: 'Тех. билетики на этот показ', key: 'drawWeight', width: 26 },
    { header: 'Выигрывал спецрозыгрыш', key: 'previousSpecialWinner', width: 24 },
    { header: 'Коэффициент веса', key: 'previousWinnerWeightPercent', width: 20 },
    { header: 'Штампы', key: 'stampCount', width: 10 },
    { header: 'Неявки', key: 'noShowCount', width: 10 },
    { header: 'Зачтено фото', key: 'acceptedPhotoCount', width: 14 },
    { header: 'Дата заявки', key: 'createdAt', width: 28 },
  ];

  const weightScale = result.drawMechanism.weightScale ?? computeWeightScale(result.candidates);
  for (const candidate of result.candidates) {
    candidatesSheet.addRow({
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      applicationCode: candidate.applicationCode,
      score: candidate.score,
      baseScore: candidate.baseScore,
      socialBonusPoints: candidate.socialBonusPoints,
      socialBonusRawPoints: candidate.socialBonusRawPoints,
      socialBonusActiveDays: candidate.socialBonusActiveDays,
      socialBonusEligibleActivityCount: candidate.socialBonusEligibleActivityCount,
      socialBonusLatestActivityAt: candidate.socialBonusLatestActivityAt ?? '',
      selectedShowingCount: candidate.selectedShowingCount,
      showingWeight: formatShowingWeight(candidate.score, candidate.selectedShowingCount),
      drawWeight: getDistributedDrawWeight(candidate, weightScale),
      previousSpecialWinner: candidate.previousSpecialWinner ? 'да' : '',
      previousWinnerWeightPercent: `${candidate.previousWinnerWeightPercent}%`,
      stampCount: candidate.stampCount,
      noShowCount: candidate.noShowCount,
      acceptedPhotoCount: candidate.acceptedPhotoCount,
      createdAt: formatKaliningradDateTime(candidate.createdAt),
    });
  }

  const auditSheet = workbook.addWorksheet('Аудит розыгрыша');
  auditSheet.columns = [
    { header: 'Место', key: 'position', width: 10 },
    { header: 'Всего билетов в раунде', key: 'totalTickets', width: 24 },
    { header: 'Выпавший билет', key: 'selectedTicket', width: 18 },
    { header: 'Код заявки', key: 'applicationCode', width: 42 },
    { header: 'Баллы участника всего', key: 'score', width: 22 },
    { header: 'Основные баллы', key: 'baseScore', width: 14 },
    { header: 'Соцбаллы VK', key: 'socialBonusPoints', width: 14 },
    { header: 'Выбрано дат', key: 'selectedShowingCount', width: 14 },
    { header: 'Вес на показ', key: 'showingWeight', width: 18 },
    { header: 'Тех. билетики участника', key: 'drawWeight', width: 22 },
    { header: 'Выигрывал спецрозыгрыш', key: 'previousSpecialWinner', width: 24 },
    { header: 'Коэффициент веса', key: 'previousWinnerWeightPercent', width: 20 },
    { header: 'Диапазон билетов', key: 'ticketRange', width: 24 },
    { header: 'Победитель', key: 'winner', width: 14 },
    { header: 'Источник случайности', key: 'randomSource', width: 28 },
  ];

  for (const round of result.drawMechanism.audit) {
    for (const range of round.ticketRanges) {
      auditSheet.addRow({
        position: round.position,
        totalTickets: round.totalTickets,
        selectedTicket: round.selectedTicket,
        applicationCode: range.applicationCode,
        score: range.score,
        baseScore: range.baseScore ?? '',
        socialBonusPoints: range.socialBonusPoints ?? '',
        selectedShowingCount: range.selectedShowingCount ?? '',
        showingWeight: formatShowingWeight(
          range.showingWeightNumerator ?? range.score,
          range.showingWeightDenominator ?? 1,
        ),
        drawWeight: range.drawWeight ?? range.score,
        previousSpecialWinner: range.previousSpecialWinner ? 'да' : '',
        previousWinnerWeightPercent: `${range.previousWinnerWeightPercent ?? 100}%`,
        ticketRange: `№${range.ticketRangeStart}–№${range.ticketRangeEnd}`,
        winner: range.applicationId === round.winnerApplicationId ? 'да' : '',
        randomSource: round.randomSource,
      });
    }
  }

  for (const sheet of [winnersSheet, candidatesSheet, auditSheet]) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}
