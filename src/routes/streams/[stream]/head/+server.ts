import { error, json } from '@sveltejs/kit';
import { readHead, toWireHead } from '@jimvella/s3-event-store';
import { getStore, ROOM_STREAM } from '$lib/server/store';
import type { RequestHandler } from './$types';

// Long-poll tuning: hold a `?wait` request open at most LONG_POLL_MS, re-reading
// the head every POLL_INTERVAL_MS. Kept well under the Worker's limits — the
// hold is almost all idle await (timers + R2 I/O), not CPU.
const LONG_POLL_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

	// pageSize defaults to store.chunkSize, so `head` lands on a real page boundary.
	let head = await readHead(store, params.stream);

	if (url.searchParams.has('wait') && inm && inm === head.etag) {
		const deadline = Date.now() + LONG_POLL_MS;
		while (Date.now() < deadline && head.etag === inm) {
			await sleep(POLL_INTERVAL_MS);
			head = await readHead(store, params.stream);
		}
	}

	const headers = { etag: head.etag, 'cache-control': 'no-store' };

	// Conditional request: still-unchanged head → 304, no body.
	if (inm === head.etag) {
		return new Response(null, { status: 304, headers });
	}

	// Point `head` into the same paging space the feed route serves.
	const feedBase = `/streams/${encodeURIComponent(params.stream)}/events`;
	const wire = toWireHead(head, (from) => `${feedBase}?from=${from}`);
	return json(wire, { headers });
};
