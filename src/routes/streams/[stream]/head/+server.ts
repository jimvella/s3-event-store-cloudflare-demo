import { error, json } from '@sveltejs/kit';
import { readHead, toWireHead } from '@jimvella/s3-event-store';
import { getStore, ROOM_STREAM } from '$lib/server/store';
import type { RequestHandler } from './$types';

/**
 * Weak ETag comparison, per RFC 7232 §3.2 (`If-None-Match` uses the weak
 * function). Cloudflare rewrites our strong `"v9"` to a weak `W/"v9"` when it
 * compresses the response, so a strict `===` would never match a browser's
 * `If-None-Match`. Strip the optional `W/` prefix from both sides.
 */
const etagMatches = (a: string | null, b: string | null): boolean =>
	a != null && b != null && a.replace(/^W\//, '') === b.replace(/^W\//, '');

/**
 * The head resource (DESIGN.md, `GET …/head`) — the short-poll target that
 * complements the immutable feed pages.
 *
 * **Edge micro-cache:** served `Cache-Control: public, max-age=1`, so Cloudflare
 * caches it for one second. A burst of client polls within that window is
 * absorbed at the edge — no Worker invocation, no R2 read — so both costs stay
 * flat no matter how many clients poll (the classic microcaching win). Appends
 * purge the entry (see the events route) so a new head appears within a poll
 * interval, not up to a second late. Send the last `etag` as `If-None-Match` for
 * a cheap `304` revalidation once the cache goes stale.
 */
export const GET: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (params.stream !== ROOM_STREAM) throw error(404, `Unknown stream: ${params.stream}`);

	const store = getStore(platform.env);
	const head = await readHead(store, params.stream);
	const headers = { etag: head.etag, 'cache-control': 'public, max-age=1' };

	if (etagMatches(request.headers.get('if-none-match'), head.etag)) {
		return new Response(null, { status: 304, headers });
	}

	// Point `head` into the same paging space the feed route serves.
	const feedBase = `/streams/${encodeURIComponent(params.stream)}/events`;
	const wire = toWireHead(head, (from) => `${feedBase}?from=${from}`);
	return json(wire, { headers });
};
