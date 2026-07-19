import type Database from 'better-sqlite3';
import type { StoragePublisher } from '../lib/storage';
import { isHiddenOrLinkOnlyCatalogEvent } from '../lib/catalog-visibility';
import { listPublicEventStates } from './catalog';

export const REGISTRATION_STATE_MANIFEST_KEY = 'tickets/registration/states.json';

export function buildPublicStateManifest(db: Database.Database) {
  return {
    generatedAt: new Date().toISOString(),
    items: listPublicEventStates(db).filter((item) => !isHiddenOrLinkOnlyCatalogEvent(item.slug)),
  };
}

export async function publishPublicStateManifest(
  db: Database.Database,
  storagePublisher: StoragePublisher,
  key = REGISTRATION_STATE_MANIFEST_KEY,
) {
  const manifest = buildPublicStateManifest(db);

  await storagePublisher.publishPublicAsset({
    key,
    body: JSON.stringify(manifest),
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=5, stale-while-revalidate=30, stale-if-error=3600',
  });

  return manifest;
}
