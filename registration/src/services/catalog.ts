import type Database from 'better-sqlite3';
import { derivePublicState, deriveSeatsLeft, getCtaCopy, isDeferredPublicEvent } from '../lib/public-state';
import {
  computeRegistrationLimit,
  computeRegistrationLimitPercent,
  DEFAULT_OVERBOOKING_PERCENT,
  FUTURE_EVENT_DEFAULT_OVERBOOKING_PERCENT,
  FUTURE_EVENT_OVERBOOKING_EFFECTIVE_FROM_ISO,
} from '../lib/overbooking';
import festivalEvents from '../data/festival-events.json';
import type {
  CatalogEventSeed,
  HallSeed,
  PublicEventStateView,
  RegistrationPublicState,
} from '../types';

type FestivalEvent = {
  slug: string;
  title: string;
  durationLabel: string;
  venue: string;
  address: string;
  kind: 'dated' | 'range' | 'special';
  isoStart: string | null;
  capacity?: number | null;
  overbookingPercent?: number | null;
  registrationLimit?: number | null;
  hiddenFromPublic?: boolean;
  linkOnly?: boolean;
};

type EventRow = {
  slug: string;
  title: string;
  starts_at: string;
  ends_at: string;
  venue_name: string;
  hall_name: string;
  address: string;
  capacity: number;
  overbooking_percent: number;
  registration_limit: number;
  seats_taken: number;
  registration_public_state: RegistrationPublicState;
  registration_opens_at: string | null;
};

type CatalogSyncOverride = {
  defaultPublicState?: RegistrationPublicState;
  openOnCatalogSyncWhenStateIsSoon?: boolean;
};

const EVENT_OVERBOOKING_PERCENT_OVERRIDES: Record<string, number> = {
  'kak-govorit-o-sovetskom-kaliningrade-bez-nostalgicheskogo-tumana-i-bez-styda': 82,
  'istoriya-obrazovaniya-i-razvitiya-natsionalnogo-parka-kurshskaya-kosa': 108,
  'pamyatniki-iskusstva-i-istorii-v-landshafte-kaliningradskogo-zooparka': 20,
  'velikie-uchitelya-preemstvennost-hudozhestvennyh-pokoleniy': 20,
};
const EVENT_CATALOG_SYNC_OVERRIDES: Record<string, CatalogSyncOverride> = {
  'privychki-kaliningradtsev-ty-nastoyaschiy-kaliningradets-esli-kaliningradtsy-glazami-gostey': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'kaliningradskaya-oblast-glazami-turistov-togda-i-seychas': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'kaliningrad-gorod-sad-ili-mikrorayon-dlya-prozhivaniya-u-morya': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'demografiya-pervogo-desyatiletiya-kaliningradskoy-oblasti': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'kaliningradskiy-morskoy-torgovyy-port-yarkie-stranitsy-sovetskoy-istorii-i-sovremennost': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'kaliningrad-korabelnyy-ot-pervyh-dney-k-vershinam-slavy-zavoda-yantar': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'ot-konfrontatsii-k-sosuschestvovaniyu-kak-vystraivalis-otnosheniya-mezhdu-sovetskimi-pereselentsami-i-nemetskim-naseleniem-kenigsberga-kaliningrada-v-pervye-poslevoennye-gody': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
  'stendap-prezentatsiya-sayta-anonsov-sobytiy': {
    defaultPublicState: 'open',
    openOnCatalogSyncWhenStateIsSoon: true,
  },
};
function isTretyakovHall(hall: HallSeed) {
  return `${hall.venueName} ${hall.hallName} ${hall.address}`.toLowerCase().includes('третьяков');
}

function getDefaultOverbookingPercentForEvent(event: FestivalEvent, hall: HallSeed) {
  if (
    !isTretyakovHall(hall)
    && event.isoStart
    && new Date(event.isoStart).getTime() >= new Date(FUTURE_EVENT_OVERBOOKING_EFFECTIVE_FROM_ISO).getTime()
  ) {
    return FUTURE_EVENT_DEFAULT_OVERBOOKING_PERCENT;
  }

  return DEFAULT_OVERBOOKING_PERCENT;
}

const HALLS: HallSeed[] = [
  {
    code: 'scientific-library-lecture-hall',
    venueName: 'Калининградская областная научная библиотека',
    hallName: 'Лекционный зал, 4 этаж',
    address: 'проспект Мира, 9/11',
    capacity: 80,
  },
  {
    code: 'bfu-scientific-library',
    venueName: 'Научная библиотека БФУ им. И. Канта',
    hallName: 'Читальный зал',
    address: 'Университетская ул., 2',
    capacity: 50,
  },
  {
    code: 'chekhov-library-reading-room',
    venueName: 'Центральная городская библиотека им. А. П. Чехова',
    hallName: 'Читальный зал',
    address: 'Московский пр-т, 39',
    capacity: 80,
  },
  {
    code: 'icae-hall',
    venueName: 'ИЦАЭ, КГТУ',
    hallName: 'Зал, 2 этаж',
    address: 'Советский проспект, 1',
    capacity: 200,
  },
  {
    code: 'tretyakov-cinema',
    venueName: 'Филиал Государственной Третьяковской галереи в Калининграде',
    hallName: 'Кинозал',
    address: 'Парадная набережная, 3',
    capacity: 241,
  },
  {
    code: 'friedland-gate-hall',
    venueName: 'Музей «Фридландские ворота»',
    hallName: 'Корпус Блокгауз',
    address: 'улица Дзержинского, 30, вход через музейный дворик',
    capacity: 50,
  },
  {
    code: 'world-ocean-okeaniya',
    venueName: 'Музей Мирового океана',
    hallName: 'ОКЕАНиЯ',
    address: 'Набережная Петра Великого, 1',
    capacity: 140,
  },
  {
    code: 'kghm-conference-hall',
    venueName: 'Калининградский областной историко-художественный музей',
    hallName: 'Конференц-зал',
    address: 'улица Клиническая, 21',
    capacity: 220,
  },
];

function addMinutes(isoStart: string, minutes: number) {
  const start = new Date(isoStart);
  return new Date(start.getTime() + minutes * 60_000).toISOString();
}

function getOptionalNonNegativeInteger(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function getDefaultDurationMinutes(event: FestivalEvent) {
  const match = event.durationLabel.match(/(\d+)\s*мин/u);
  if (match) {
    return Number(match[1]);
  }

  const hoursMatch = event.durationLabel.match(/(\d+)\s*ч/u);
  if (hoursMatch) {
    return Number(hoursMatch[1]) * 60;
  }

  return 90;
}

function matchHall(event: FestivalEvent) {
  const venue = `${event.venue} ${event.address}`.toLowerCase();

  if (venue.includes('научн') && venue.includes('библиот')) {
    if (venue.includes('бфу') || venue.includes('университетск')) {
      return HALLS[1];
    }

    return HALLS[0];
  }

  if (venue.includes('чехов') && venue.includes('библиот')) {
    return HALLS[2];
  }

  if (venue.includes('ицаэ') || venue.includes('кгту')) {
    return HALLS[3];
  }

  if (venue.includes('третьяков')) {
    return HALLS[4];
  }

  if (venue.includes('фридланд')) {
    return HALLS[5];
  }

  if (venue.includes('мирового океана')) {
    return HALLS[6];
  }

  if (venue.includes('историко') || venue.includes('клиническ')) {
    return HALLS[7];
  }

  return null;
}

function toCatalogSeed(event: FestivalEvent): CatalogEventSeed | null {
  if (event.kind !== 'dated' || !event.isoStart) {
    return null;
  }

  const hall = matchHall(event);
  const durationMinutes = getDefaultDurationMinutes(event);
  const startsAt = new Date(event.isoStart).toISOString();
  const endsAt = addMinutes(startsAt, durationMinutes);
  const syncOverride = EVENT_CATALOG_SYNC_OVERRIDES[event.slug];

  if (!hall) {
    return {
      slug: event.slug,
      title: event.title,
      startsAt,
      endsAt,
      venueName: event.venue,
      hallName: event.venue,
      address: event.address,
      capacity: 0,
      overbookingPercent: 0,
      registrationLimit: 0,
      sourceStatus: 'needs_mapping',
      defaultPublicState: syncOverride?.defaultPublicState ?? 'closed',
    };
  }

  const capacity = getOptionalNonNegativeInteger(event.capacity) ?? hall.capacity;
  const overbookingPercent = getOptionalNonNegativeInteger(event.overbookingPercent)
    ?? EVENT_OVERBOOKING_PERCENT_OVERRIDES[event.slug]
    ?? getDefaultOverbookingPercentForEvent(event, hall);
  const registrationLimit = getOptionalNonNegativeInteger(event.registrationLimit)
    ?? computeRegistrationLimit(capacity, overbookingPercent);

  return {
    slug: event.slug,
    title: event.title,
    startsAt,
    endsAt,
    venueName: hall.venueName,
    hallName: hall.hallName,
    address: hall.address,
    capacity,
    overbookingPercent,
    registrationLimit,
    sourceStatus: 'ready',
    defaultPublicState: syncOverride?.defaultPublicState ?? 'soon',
  };
}

function getCatalogSeeds() {
  return (festivalEvents as FestivalEvent[])
    .map(toCatalogSeed)
    .filter((item): item is CatalogEventSeed => Boolean(item));
}

export function syncCatalog(db: Database.Database) {
  const insertHall = db.prepare(`
    INSERT INTO halls(code, venue_name, hall_name, address, capacity)
    VALUES (@code, @venueName, @hallName, @address, @capacity)
    ON CONFLICT(code) DO UPDATE SET
      venue_name = excluded.venue_name,
      hall_name = excluded.hall_name,
      address = excluded.address,
      capacity = excluded.capacity,
      updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  for (const hall of HALLS) {
    insertHall.run(hall);
  }

  const hallRows = db.prepare('SELECT code, id FROM halls').all() as Array<{ code: string; id: number }>;
  const hallIdByCode = new Map<string, number>(hallRows.map((row) => [row.code, row.id]));

  const findHallId = (seed: CatalogEventSeed) => {
    const hall = HALLS.find((item) =>
      item.venueName === seed.venueName
      && item.hallName === seed.hallName
      && item.address === seed.address,
    );

    return hall ? hallIdByCode.get(hall.code) ?? null : null;
  };

  const upsertEvent = db.prepare(`
    INSERT INTO events(
      slug,
      title,
      starts_at,
      ends_at,
      venue_name,
      hall_name,
      address,
      hall_id,
      capacity,
      overbooking_percent,
      registration_limit,
      registration_public_state,
      source_status,
      source_updated_at
    ) VALUES (
      @slug,
      @title,
      @startsAt,
      @endsAt,
      @venueName,
      @hallName,
      @address,
      @hallId,
      @capacity,
      @overbookingPercent,
      @registrationLimit,
      @defaultPublicState,
      @sourceStatus,
      (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      hall_name = excluded.hall_name,
      address = excluded.address,
      hall_id = excluded.hall_id,
      capacity = excluded.capacity,
      overbooking_percent = excluded.overbooking_percent,
      registration_limit = excluded.registration_limit,
      source_status = excluded.source_status,
      source_updated_at = excluded.source_updated_at,
      updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  const openEventOnSync = db.prepare(`
    UPDATE events
    SET registration_public_state = 'open',
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE slug = @slug
      AND registration_public_state = 'soon'
      AND venue_name = @venueName
      AND hall_name = @hallName
      AND address = @address
  `);

  const sync = db.transaction(() => {
    for (const seed of getCatalogSeeds()) {
      upsertEvent.run({
        ...seed,
        hallId: findHallId(seed),
      });

      const syncOverride = EVENT_CATALOG_SYNC_OVERRIDES[seed.slug];
      if (syncOverride?.openOnCatalogSyncWhenStateIsSoon && seed.defaultPublicState === 'open') {
        openEventOnSync.run({
          slug: seed.slug,
          venueName: seed.venueName,
          hallName: seed.hallName,
          address: seed.address,
        });
      }
    }
  });

  sync();
}

export function listPublicEventStates(db: Database.Database, slugs: string[] = []): PublicEventStateView[] {
  const where = slugs.length
    ? `WHERE slug IN (${slugs.map(() => '?').join(', ')})`
    : '';

  const rows = db.prepare(`
    SELECT
      slug,
      title,
      starts_at,
      ends_at,
      venue_name,
      hall_name,
      address,
      capacity,
      overbooking_percent,
      registration_limit,
      seats_taken,
      registration_public_state,
      registration_opens_at
    FROM events
    ${where}
    ORDER BY starts_at ASC, title ASC
  `).all(...slugs) as EventRow[];

  return rows.map((row) => {
    const publicState = derivePublicState(row);
    const copy = getCtaCopy(publicState);
    const hidePublicDetails = isDeferredPublicEvent(row);
    const seatsLeft = deriveSeatsLeft(row);

    return {
      slug: row.slug,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      venueName: hidePublicDetails ? '' : row.venue_name,
      hallName: hidePublicDetails ? '' : row.hall_name,
      address: hidePublicDetails ? '' : row.address,
      capacity: row.capacity,
      overbookingPercent: row.overbooking_percent,
      registrationLimit: row.registration_limit,
      registrationLimitPercent: computeRegistrationLimitPercent(row.overbooking_percent),
      seatsTaken: row.seats_taken,
      seatsLeft,
      publicState,
      registrationPublicState: row.registration_public_state,
      ctaLabel: copy.ctaLabel,
      ctaNotice: copy.ctaNotice,
      opensAt: row.registration_opens_at,
    };
  });
}
