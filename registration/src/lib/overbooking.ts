export const DEFAULT_OVERBOOKING_PERCENT = 51;

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
