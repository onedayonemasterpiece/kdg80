import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import type Database from 'better-sqlite3';
import { decryptPii } from '../lib/crypto';

type SpecialEventRow = {
  id: number;
  slug: string;
  title: string;
  format_label: string;
  venue_name: string;
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
  uploaded_photo_count: number;
  unique_photo_count: number;
  accepted_photo_count: number;
  stamp_count: number;
  ordinary_registration_count: number;
  no_show_count: number;
  score: number;
  created_at: string;
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

export type SpecialParticipant = {
  applicationId: number;
  applicationCode: string;
  participantProfileId: number | null;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  score: number;
  stampCount: number;
  ordinaryRegistrationCount: number;
  noShowCount: number;
  uploadedPhotoCount: number;
  uniquePhotoCount: number;
  acceptedPhotoCount: number;
  selectedShowingCount: number;
  createdAt: string;
};

export type SpecialDrawWinner = SpecialParticipant & {
  position: number;
  selectedTicket: number;
  ticketRangeStart: number;
  ticketRangeEnd: number;
  poolWeightBeforeDraw: number;
  randomSource: string;
};

export type SpecialDrawTicketRange = {
  applicationId: number;
  applicationCode: string;
  score: number;
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
    algorithm: 'weighted_ticket_draw_without_replacement';
    ticketRule: '1_score_point_equals_1_ticket';
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
    SELECT id, slug, title, format_label, venue_name
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

function getPublishedWinnerProfileIdsForOtherSpecialDraws(
  db: Database.Database,
  currentShowingId: number,
) {
  const rows = db.prepare(`
    SELECT dr.*
    FROM special_draw_runs dr
    WHERE dr.showing_id != ?
      AND dr.run_type = 'published'
    ORDER BY dr.id ASC
  `).all(currentShowingId) as SpecialDrawRunRow[];

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
  const excludedProfileIds = getPublishedWinnerProfileIdsForOtherSpecialDraws(
    db,
    showing.id,
  );
  const rows = db.prepare(`
    SELECT a.*
    FROM special_applications a
    INNER JOIN special_application_showings aps ON aps.application_id = a.id
    WHERE aps.showing_id = ?
      AND a.status = 'accepted'
      AND a.score > 0
    ORDER BY a.created_at ASC, a.id ASC
  `).all(showing.id) as SpecialApplicationRow[];

  return rows.filter((row) => !row.participant_profile_id || !excludedProfileIds.has(row.participant_profile_id));
}

function mapParticipants(rows: SpecialApplicationRow[], privateKeyPemBase64: string) {
  return rows.flatMap((row) => {
    try {
      const pii = decryptPii(privateKeyPemBase64, {
        piiCiphertext: row.pii_ciphertext,
        piiWrappedKey: row.pii_wrapped_key,
        piiIv: row.pii_iv,
        piiAlg: row.pii_alg,
      });

      return [{
        applicationId: row.id,
        applicationCode: row.application_code,
        participantProfileId: row.participant_profile_id,
        fullName: pii.fullName ?? '',
        email: pii.email ?? '',
        phone: pii.phone ?? '',
        status: row.status,
        score: row.score,
        stampCount: row.stamp_count,
        ordinaryRegistrationCount: row.ordinary_registration_count,
        noShowCount: row.no_show_count,
        uploadedPhotoCount: row.uploaded_photo_count,
        uniquePhotoCount: row.unique_photo_count,
        acceptedPhotoCount: row.accepted_photo_count,
        selectedShowingCount: countSelectedShowings(row.selected_showing_ids_json),
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

  while (pool.length && winners.length < limit) {
    const totalWeight = pool.reduce((sum, candidate) => sum + candidate.score, 0);
    if (totalWeight <= 0) {
      break;
    }

    const selectedTicket = crypto.randomInt(totalWeight) + 1;
    let target = selectedTicket;
    let winnerIndex = -1;
    let ticketCursor = 1;
    const ticketRanges: SpecialDrawTicketRange[] = [];
    for (const [index, candidate] of pool.entries()) {
      const ticketRangeStart = ticketCursor;
      const ticketRangeEnd = ticketCursor + candidate.score - 1;
      ticketRanges.push({
        applicationId: candidate.applicationId,
        applicationCode: candidate.applicationCode,
        score: candidate.score,
        ticketRangeStart,
        ticketRangeEnd,
      });

      target -= candidate.score;
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

  return { winners, audit, randomSource };
}

function snapshotParticipant(participant: SpecialParticipant) {
  return {
    applicationId: participant.applicationId,
    applicationCode: participant.applicationCode,
    participantProfileId: participant.participantProfileId,
    score: participant.score,
    stampCount: participant.stampCount,
    ordinaryRegistrationCount: participant.ordinaryRegistrationCount,
    noShowCount: participant.noShowCount,
    uploadedPhotoCount: participant.uploadedPhotoCount,
    uniquePhotoCount: participant.uniquePhotoCount,
    acceptedPhotoCount: participant.acceptedPhotoCount,
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
    SELECT id, slug, title, format_label, venue_name
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
  const candidates = privateKeyPemBase64 ? mapParticipants(acceptedRows, privateKeyPemBase64) : [];
  const latestDraft = getLatestDrawRow(db, showing.id, 'draft');
  const latestPublished = getLatestDrawRow(db, showing.id, 'published');

  return {
    event,
    showing,
    acceptedApplicationCount: acceptedRows.length,
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

  const candidates = mapParticipants(listCandidateRows(db, showing), privateKeyPemBase64);
  const draw = weightedDraw(candidates, showing.lottery_quota);
  const winners = draw.winners;
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
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
      algorithm: 'weighted_ticket_draw_without_replacement',
      ticketRule: '1_score_point_equals_1_ticket',
      randomSource: draw.randomSource,
      audit: draw.audit,
    } as const,
    winners: winners.map((winner) => ({
      position: winner.position,
      applicationId: winner.applicationId,
      applicationCode: winner.applicationCode,
      participantProfileId: winner.participantProfileId,
      score: winner.score,
      stampCount: winner.stampCount,
      noShowCount: winner.noShowCount,
      selectedTicket: winner.selectedTicket,
      ticketRangeStart: winner.ticketRangeStart,
      ticketRangeEnd: winner.ticketRangeEnd,
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

  const allRows = db.prepare(`
    SELECT a.*
    FROM special_applications a
    INNER JOIN special_application_showings aps ON aps.application_id = a.id
    WHERE aps.showing_id = ?
    ORDER BY a.created_at ASC, a.id ASC
  `).all(showing.id) as SpecialApplicationRow[];

  return rowToDrawResult(row, event, showing, mapParticipants(allRows, privateKeyPemBase64));
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
    `   Баллы: ${candidate.score}, штампы: ${candidate.stampCount}, неявки: ${candidate.noShowCount}`,
    `   Фото: ${candidate.acceptedPhotoCount}/${candidate.uniquePhotoCount}/${candidate.uploadedPhotoCount}`,
    `   Выбрано дат: ${candidate.selectedShowingCount}`,
    `   Код заявки: ${candidate.applicationCode}`,
  ].join('\n'));

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
    `Билетов в барабане: ${result.totalWeight}`,
    `Победителей: ${result.winners.length} из ${result.showing.lottery_quota}`,
    'Механика: 1 балл = 1 билет; выбирается один случайный номер билета в раунде.',
    `Источник случайности: ${result.drawMechanism.randomSource}`,
    '',
  ];

  if (!result.winners.length) {
    return [...header, 'Победителей нет: недостаточно допущенных заявок.'].join('\n');
  }

  const winners = result.winners.slice(0, 30).map((winner) => [
    `${winner.position}. ${winner.fullName}`,
    `   Баллы: ${winner.score}, штампы: ${winner.stampCount}, неявки: ${winner.noShowCount}`,
    `   Раунд: выпал билет №${winner.selectedTicket} из ${winner.poolWeightBeforeDraw}`,
    `   Билеты участника: №${winner.ticketRangeStart}–${winner.ticketRangeEnd} (${winner.score} шт.)`,
    `   ${maskEmail(winner.email)}, ${maskPhone(winner.phone)}`,
    `   Код заявки: ${winner.applicationCode}`,
  ].join('\n'));

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
    { header: 'Баллы', key: 'score', width: 10 },
    { header: 'Выпавший билет', key: 'selectedTicket', width: 18 },
    { header: 'Всего билетов в раунде', key: 'poolWeightBeforeDraw', width: 24 },
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
    { header: 'Баллы', key: 'score', width: 10 },
    { header: 'Штампы', key: 'stampCount', width: 10 },
    { header: 'Неявки', key: 'noShowCount', width: 10 },
    { header: 'Зачтено фото', key: 'acceptedPhotoCount', width: 14 },
    { header: 'Дата заявки', key: 'createdAt', width: 28 },
  ];

  for (const candidate of result.candidates) {
    candidatesSheet.addRow({
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      applicationCode: candidate.applicationCode,
      score: candidate.score,
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
    { header: 'Баллы участника', key: 'score', width: 18 },
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
