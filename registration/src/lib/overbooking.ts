export const DEFAULT_OVERBOOKING_PERCENT = 77;
export const FUTURE_EVENT_ADDITIONAL_OVERBOOKING_PERCENT = 6;
export const FUTURE_EVENT_OVERBOOKING_EFFECTIVE_FROM_ISO = '2026-07-03T00:00:00.000Z';
export const FUTURE_EVENT_DEFAULT_OVERBOOKING_PERCENT = DEFAULT_OVERBOOKING_PERCENT
  + FUTURE_EVENT_ADDITIONAL_OVERBOOKING_PERCENT;

export function normalizeOverbookingPercent(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_OVERBOOKING_PERCENT;
  }

  return Math.max(0, Math.floor(value));
}

export function computeRegistrationLimit(capacity: number, overbookingPercent: number) {
  const safeCapacity = Math.max(0, Math.floor(capacity));
  const safePercent = normalizeOverbookingPercent(overbookingPercent);

  return Math.max(0, Math.floor((safeCapacity * (100 + safePercent)) / 100));
}

export function computeRegistrationLimitPercent(overbookingPercent: number) {
  return 100 + normalizeOverbookingPercent(overbookingPercent);
}

export function computeRegistrationSeatsLeft(registrationLimit: number, seatsTaken: number) {
  return Math.max(Math.floor(registrationLimit) - Math.floor(seatsTaken), 0);
}
