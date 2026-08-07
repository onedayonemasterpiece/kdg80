import type Database from 'better-sqlite3';

export type TelegramUpdateEnvelope = {
  update_id?: unknown;
  message?: { date?: unknown };
  edited_message?: { date?: unknown };
  channel_post?: { date?: unknown };
  edited_channel_post?: { date?: unknown };
};

export function getTelegramUpdateId(update: TelegramUpdateEnvelope): number | null {
  const value = update.update_id;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function getMessageTimestampSeconds(update: TelegramUpdateEnvelope): number | null {
  const candidates = [
    update.message?.date,
    update.edited_message?.date,
    update.channel_post?.date,
    update.edited_channel_post?.date,
  ];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }

  return null;
}

export function isStaleTelegramMessageUpdate(
  update: TelegramUpdateEnvelope,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const messageTimestamp = getMessageTimestampSeconds(update);
  if (messageTimestamp === null) {
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
