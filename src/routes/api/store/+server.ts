import { error, json } from '@sveltejs/kit';
import {
	edgeCache,
	feedPageCacheKey,
	getStore,
	headVersion,
	ROOM_STREAM
} from '$lib/server/store';
import { listObjects, wipeBucket } from '$lib/server/browser';
import type { RequestHandler } from './$types';

/** GET /api/store — the list of objects currently in the bucket. */
export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	return json({ objects: await listObjects(platform.env.EVENTS) });
};

/**
 * DELETE /api/store — the demo reset. Deletes every object in the bucket and
 * flushes the edge cache of the (now-stale) immutable feed pages, so the same
 * page URLs don't keep serving pre-wipe content.
 */
export const DELETE: RequestHandler = async ({ platform, locals, url }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const store = getStore(platform.env);
	const oldHead = await headVersion(store); // -1 if the stream is already empty
	const deleted = await wipeBucket(platform.env.EVENTS);

	// Purge the cached complete pages for the range that existed before the wipe.
	// Cover both URL encodings a client might have requested (the app uses the
	// %3A-encoded stream id; the API browser uses the raw colon), since the edge
	// caches each form under its own key. Best-effort and per-colo — the Cache
	// API can't purge globally without the Cloudflare API.
	let purged = 0;
	const cache = edgeCache();
	if (cache) {
		for (let from = 0; from <= oldHead; from += store.chunkSize) {
			const encoded = feedPageCacheKey(url.origin, ROOM_STREAM, from);
			const raw = new Request(`${url.origin}/streams/${ROOM_STREAM}/events?from=${from}`);
			for (const key of [encoded, raw]) {
				try {
					if (await cache.delete(key)) purged++;
				} catch {
					/* ignore */
				}
			}
		}
	}

	return json({ deleted, purged });
};
