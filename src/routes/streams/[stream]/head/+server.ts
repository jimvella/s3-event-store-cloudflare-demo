import { error, json } from '@sveltejs/kit';
import { readHead, toWireHead } from '@jimvella/s3-event-store';
import { getStore, ROOM_STREAM } from '$lib/server/store';
import type { RequestHandler } from './$types';

/**
 * The head resource (DESIGN.md, `GET …/head`) — the pollable "current version"
 * target that complements the immutable feed pages. A poller re-fetches this
 * under `no-store`, and if `version` moved it follows `head` into the paging
 * space. The `etag` makes the loop nearly free: send it back as `If-None-Match`
 * and unchanged heads answer `304 Not Modified`.
 */
export const GET: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (params.stream !== ROOM_STREAM) throw error(404, `Unknown stream: ${params.stream}`);

	const store = getStore(platform.env);
	// pageSize defaults to store.chunkSize, so `head` lands on a real page boundary.
	const head = await readHead(store, params.stream);

	// Conditional request: unchanged head → 304, no body.
	if (request.headers.get('if-none-match') === head.etag) {
		return new Response(null, { status: 304, headers: { etag: head.etag, 'cache-control': 'no-store' } });
	}

	// Point `head` into the same paging space the feed route serves.
	const feedBase = `/streams/${encodeURIComponent(params.stream)}/events`;
	const wire = toWireHead(head, (from) => `${feedBase}?from=${from}`);

	return json(wire, { headers: { etag: head.etag, 'cache-control': 'no-store' } });
};
