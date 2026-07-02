import type Database from 'better-sqlite3';
import type { StoragePublisher } from '../lib/storage';
import { listPublicEventStates } from './catalog';
import festivalEvents from '../data/festival-events.json';

export const REGISTRATION_STATE_MANIFEST_KEY = 'tickets/registration/states.json';

type CatalogManifestEvent = {
  slug?: string;
  hiddenFromPublic?: boolean;
  linkOnly?: boolean;
};

const LINK_ONLY_OR_HIDDEN_SLUGS = new Set(
  (festivalEvents as CatalogManifestEvent[])
    .filter((event) => event.hiddenFromPublic || event.linkOnly)
    .map((event) => event.slug)
    .filter((slug): slug is string => Boolean(slug)),
);

export function buildPublicStateManifest(db: Database.Database) {
  return {
    generatedAt: new Date().toISOString(),
    items: listPublicEventStates(db).filter((item) => !LINK_ONLY_OR_HIDDEN_SLUGS.has(item.slug)),
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
