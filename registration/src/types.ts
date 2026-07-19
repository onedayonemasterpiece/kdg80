export type RegistrationPublicState = 'open' | 'soon' | 'closed';

export type PublicEventCtaState =
  | 'registration_open'
  | 'registration_soon'
  | 'registration_closed'
  | 'sold_out'
  | 'past';

export type HallSeed = {
  code: string;
  venueName: string;
  hallName: string;
  address: string;
  capacity: number;
};

export type CatalogEventSeed = {
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string;
  venueName: string;
  hallName: string;
  address: string;
  capacity: number;
  overbookingPercent: number;
  registrationLimit: number;
  sourceStatus: 'ready' | 'needs_mapping';
  defaultPublicState: RegistrationPublicState;
};

export type PublicEventStateView = {
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string;
  publicDetailsDeferred: boolean;
  venueName: string;
  hallName: string;
  address: string;
  capacity: number;
  overbookingPercent: number;
  registrationLimit: number;
  registrationLimitPercent: number;
  seatsTaken: number;
  seatsLeft: number;
  publicState: PublicEventCtaState;
  registrationPublicState: RegistrationPublicState;
  ctaLabel: string;
  ctaNotice?: string;
  opensAt: string | null;
};

export type RegistrationPayload = {
  eventSlug: string;
  fullName: string;
  email: string;
  phone: string;
  consentAccepted: boolean;
  website?: string;
  testRunId?: string;
};

export type TicketArtifacts = {
  ticketUrl: string;
  pdfUrl: string;
  icsUrl: string;
};
