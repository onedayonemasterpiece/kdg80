import type { PublicEventCtaState, RegistrationPublicState } from '../types';
import { computeRegistrationSeatsLeft } from './overbooking';
import festivalEvents from '../data/festival-events.json';

type EventStateRow = {
  slug?: string;
  starts_at: string;
  ends_at: string;
  venue_name?: string;
  hall_name?: string;
  address?: string;
  capacity: number;
  overbooking_percent: number;
  registration_limit: number;
  seats_taken: number;
  registration_public_state: RegistrationPublicState;
};

type CatalogVisibilityEvent = {
  slug?: string;
  linkOnly?: boolean;
};

const LINK_ONLY_EVENT_SLUGS = new Set(
  (festivalEvents as CatalogVisibilityEvent[])
    .filter((event) => event.linkOnly)
    .map((event) => event.slug)
    .filter((slug): slug is string => Boolean(slug)),
);

export function isDeferredPublicEvent(row: Pick<EventStateRow, 'slug' | 'venue_name' | 'hall_name' | 'address'>) {
  if (row.slug && LINK_ONLY_EVENT_SLUGS.has(row.slug)) {
    return false;
  }

  const lookup = [
    row.slug ?? '',
    row.venue_name ?? '',
    row.hall_name ?? '',
    row.address ?? '',
  ].join(' ').toLowerCase();

  return (
    lookup.includes('ицаэ')
    || lookup.includes('кгту')
    || lookup.includes('советский проспект')
  );
}

export function derivePublicState(row: EventStateRow, now = new Date()): PublicEventCtaState {
  const nowMs = now.getTime();
  const startsAtMs = new Date(row.starts_at).getTime();
  const endsAtMs = new Date(row.ends_at).getTime();

  if (!Number.isNaN(startsAtMs) && nowMs >= startsAtMs) {
    return 'past';
  }

  if (!Number.isNaN(endsAtMs) && nowMs >= endsAtMs) {
    return 'past';
  }

  if (isDeferredPublicEvent(row)) {
    return 'registration_soon';
  }

  if (row.seats_taken >= row.registration_limit) {
    return 'sold_out';
  }

  if (row.registration_public_state === 'open') {
    return 'registration_open';
  }

  if (row.registration_public_state === 'closed') {
    return 'registration_closed';
  }

  return 'registration_soon';
}

export function deriveSeatsLeft(row: Pick<EventStateRow, 'registration_limit' | 'seats_taken'>) {
  return computeRegistrationSeatsLeft(row.registration_limit, row.seats_taken);
}

export function getCtaCopy(publicState: PublicEventCtaState) {
  switch (publicState) {
    case 'registration_open':
      return {
        ctaLabel: 'Регистрация',
      };
    case 'registration_soon':
      return {
        ctaLabel: 'Регистрация скоро откроется',
        ctaNotice: 'Регистрация на мероприятие скоро откроется.',
      };
    case 'registration_closed':
      return {
        ctaLabel: 'Регистрация закрыта',
        ctaNotice: 'Регистрация на это событие сейчас закрыта.',
      };
    case 'sold_out':
      return {
        ctaLabel: 'Мест нет',
        ctaNotice: 'Свободные места закончились.',
      };
    case 'past':
    default:
      return {
        ctaLabel: 'Событие прошло',
        ctaNotice: 'Событие уже прошло.',
      };
  }
}
