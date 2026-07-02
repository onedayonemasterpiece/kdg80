import type { APIRoute } from 'astro';
import { buildIcs, getFestivalEvents } from '../../lib/festival';

export const prerender = true;

export function getStaticPaths() {
  return getFestivalEvents({ includeHidden: true })
    .filter((event) => event.calendarReady && (!event.hiddenFromPublic || event.linkOnly))
    .map((event) => ({
      params: { slug: event.slug },
      props: { event },
    }));
}

export const GET: APIRoute = ({ props }) => {
  const event = props.event;
  const body = buildIcs(event);

  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${event.slug}.ics"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
