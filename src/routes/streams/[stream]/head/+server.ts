import { error, json } from '@sveltejs/kit';
import { toWireHead } from '@jimvella/s3-event-store';
import { cachedReadHead, getStore, ROOM_STREAM } from '$lib/server/store';
import type { RequestHandler } from './$types';

// Long-poll tuning: hold a `?wait` request open at most LONG_POLL_MS, re-reading
// the head every POLL_INTERVAL_MS. Kept well under the Worker's limits — the
// hold is almost all idle await (timers + R2 I/O), not CPU.
const LONG_POLL_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Weak ETag comparison, per RFC 7232 §3.2 (`If-None-Match` uses the weak
 * function). Cloudflare rewrites our strong `"v9"` to a *weak* `W/"v9"` whenever
 * it compresses the response, so a strict `===` would never match a browser's
 * `If-None-Match` — the hold would be skipped and long polling would collapse
 * into a busy loop. Strip the optional `W/` prefix from both sides before comparing.
 */
const etagMatches = (a: string | null, b: string | null): boolean =>
	a != null && b != null && a.replace(/^W\//, '') === b.replace(/^W\//, '');

/**
 * The head resource (DESIGN.md, `GET …/head`) — the pollable "current version"
 * target that complements the immutable feed pages. Send the last `etag` back as
 * `If-None-Match`; an unchanged head answers `304 Not Modified`.
 *
 * Add `?wait` for **long polling**: when the caller's ETag still matches, the
 * request is held open and the head re-read until it moves (→ `200` with the new
 * head) or the deadline elapses (→ `304`, and the client immediately re-polls).
 * This turns the idle poll loop into one held request instead of many, and
 * delivers a new head within POLL_INTERVAL_MS of it being written.
 */
export const GET: RequestHandler = async ({ params, request, url, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (params.stream !== ROOM_STREAM) throw error(404, `Unknown stream: ${params.stream}`);

	const store = getStore(platform.env);
	const inm = request.headers.get('if-none-match');

	// Read through a 1s edge micro-cache so a burst of concurrent pollers collapses
	// to ~one R2 head read per second per colo (see cachedReadHead).
	let head = await cachedReadHead(store, url.origin, params.stream);

	if (url.searchParams.has('wait') && etagMatches(inm, head.etag)) {
		const deadline = Date.now() + LONG_POLL_MS;
		while (Date.now() < deadline && etagMatches(inm, head.etag)) {
			await sleep(POLL_INTERVAL_MS);
			head = await cachedReadHead(store, url.origin, params.stream);
		}
	}

	const headers = { etag: head.etag, 'cache-control': 'no-store' };

	// Conditional request: still-unchanged head → 304, no body.
	if (etagMatches(inm, head.etag)) {
		return new Response(null, { status: 304, headers });
	}

	// Point `head` into the same paging space the feed route serves.
	const feedBase = `/streams/${encodeURIComponent(params.stream)}/events`;
	const wire = toWireHead(head, (from) => `${feedBase}?from=${from}`);
	return json(wire, { headers });
};
