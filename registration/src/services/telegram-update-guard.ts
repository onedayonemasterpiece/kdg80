import type Database from 'better-sqlite3';

export type TelegramUpdateEnvelope = {
  update_id?: unknown;
  message?: {
    date?: unknown;
    text?: unknown;
  };
  callback_query?: {
    data?: unknown;
  };
};

export function getTelegramUpdateId(update: TelegramUpdateEnvelope): number | null {
  const value = update.update_id;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }

  return value;
}

export function isFullExportUpdate(update: TelegramUpdateEnvelope) {
  const text = update.message?.text;
  if (
    typeof text === 'string'
    && /^\/export_all(?:@\w+)?(?:\s|$)/u.test(text.trim())
  ) {
    return true;
  }

  return update.callback_query?.data === 'exp:all';
}

export function isStaleFullExportUpdate(
  update: TelegramUpdateEnvelope,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (!isFullExportUpdate(update)) {
    return false;
  }

  const messageTimestamp = update.message?.date;
  if (
    typeof messageTimestamp !== 'number'
    || !Number.isSafeInteger(messageTimestamp)
    || messageTimestamp <= 0
  ) {
    return false;
  }

  return nowSeconds - messageTimestamp > maxAgeSeconds;
}

export function claimTelegramUpdate(db: Database.Database, updateId: number) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO telegram_update_claims(update_id)
    VALUES (?)
  `).run(updateId);

  return result.changes === 1;
}
