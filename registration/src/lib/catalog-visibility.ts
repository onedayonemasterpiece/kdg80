import festivalEvents from '../data/festival-events.json';

type CatalogVisibilityEvent = {
  slug?: string;
  hiddenFromPublic?: boolean;
  linkOnly?: boolean;
  publicDetailsDeferred?: boolean;
};

const CATALOG_EVENTS = festivalEvents as CatalogVisibilityEvent[];

const LINK_ONLY_EVENT_SLUGS = new Set(
  CATALOG_EVENTS
    .filter((event) => event.linkOnly)
    .map((event) => event.slug)
    .filter((slug): slug is string => Boolean(slug)),
);

const PUBLIC_DETAILS_DEFERRED_SLUGS = new Set(
  CATALOG_EVENTS
    .filter((event) => event.publicDetailsDeferred)
    .map((event) => event.slug)
    .filter((slug): slug is string => Boolean(slug)),
);

export function isLinkOnlyCatalogEvent(slug: string | null | undefined) {
  return Boolean(slug && LINK_ONLY_EVENT_SLUGS.has(slug));
}

export function arePublicEventDetailsDeferred(slug: string | null | undefined) {
  return Boolean(slug && PUBLIC_DETAILS_DEFERRED_SLUGS.has(slug));
}

export function isHiddenOrLinkOnlyCatalogEvent(slug: string | null | undefined) {
  if (!slug) {
    return false;
  }

  return CATALOG_EVENTS.some((event) => (
    event.slug === slug && Boolean(event.hiddenFromPublic || event.linkOnly)
  ));
}
