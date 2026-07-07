import { error, json, redirect } from '@sveltejs/kit';
import {
	canonicalFrom,
	ConcurrencyError,
	readPage,
	SubjectErasedError,
	toWireFeed
} from '@jimvella/s3-event-store';
import {
	appendEvents,
	CommandError,
	edgeCache,
	feedPageCacheKey,
	getStore,
	headResponseCacheKeys,
	headVersion,
	ROOM_STREAM
} from '$lib/server/store';
import type { RequestHandler } from './$types';

/**
 * The library's HTTP egress wire format (DESIGN.md, "HTTP reads"), built with
 * the `readPage` / `toWireFeed` helpers. Page size defaults to the store's
 * `chunkSize`, so pages align to chunk boundaries. Complete pages are immutable
 * and cacheable forever; the head page is not. Non-aligned cursors 308-redirect
 * to their canonical page URL so every client requests identical, cacheable URLs.
 *
 * Complete pages are stored in the edge cache (`caches.default`), so a repeat
 * request for one is served straight from cache without touching R2 — and the
 * Storage page's "flush caches" purges exactly these entries.
 */
export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (params.stream !== ROOM_STREAM) throw error(404, `Unknown stream: ${params.stream}`);

	const store = getStore(platform.env);
	const requested = Number(url.searchParams.get('from') ?? '0') || 0;
	const canonical = canonicalFrom(requested, store.chunkSize);
	if (url.searchParams.has('from') && requested !== canonical) {
		throw redirect(308, `${url.pathname}?from=${canonical}`);
	}

	const cache = edgeCache();
	const cacheKey = feedPageCacheKey(url.origin, params.stream, canonical);
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) return hit;
	}

	const page = await readPage(store, params.stream, { from: canonical });
	const wire = toWireFeed(page, (from) => `${url.pathname}?from=${from}`);

	// The machine-readable immutability promise: a complete page never changes.
	const cacheControl = page.complete ? 'public, max-age=31536000, immutable' : 'no-store';
	const res = json(wire, { headers: { 'cache-control': cacheControl } });

	// Only complete pages are safe to store — the head page is still growing.
	if (cache && page.complete) {
		try {
			await cache.put(cacheKey, res.clone());
		} catch {
			/* not cacheable in this runtime — ignore */
		}
	}
	return res;
};

/**
 * Raw-append ingress. The client submits its own events — each carrying a stable
 * `id` (the idempotency key) — plus the `expectedVersion` it read from the head
 * resource. `appendEvents` authorizes them and calls `idempotentAppend`:
 *   - committed now      → 201 { outcome: "appended" }
 *   - a lost-response retry already committed them → 200 { outcome: "alreadyCommitted" }
 *   - a genuine concurrent writer took the slot     → 409 { headVersion } (re-read + retry)
 *
 * When the append seals a bucket (`compactionSuggested`), we compact it via
 * `ctx.waitUntil` — the same invocation keeps running after the response to
 * fold that bucket's commits into a chunk object. It's safe to fire sloppily:
 * `compactStream` does at most one bucket per call and no-ops if there's
 * nothing to do, and racing compactors stand down.
 */
export const POST: RequestHandler = async ({ params, request, url, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (params.stream !== ROOM_STREAM) throw error(404, `Unknown stream: ${params.stream}`);

	const body = (await request.json().catch(() => ({}))) as {
		events?: unknown;
		expectedVersion?: unknown;
	};

	const ev = body.expectedVersion;
	const expectedVersion =
		ev === 'noStream' ? 'noStream' : typeof ev === 'number' && Number.isInteger(ev) && ev >= 0 ? ev : null;
	if (expectedVersion === null) {
		throw error(400, 'expectedVersion must be a version number (>= 0) or "noStream"');
	}

	const store = getStore(platform.env);
	try {
		const result = await appendEvents(store, locals.username, body.events, expectedVersion);

		if (result.outcome === 'appended') {
			// The head moved — purge its edge-cached copy so the next poll (in this
			// colo) sees the new head now, not up to the 1s TTL late. Best-effort
			// and per-colo; the TTL is the backstop for other colos.
			const cache = edgeCache();
			if (cache) {
				for (const key of headResponseCacheKeys(url.origin, ROOM_STREAM)) {
					cache.delete(key).catch(() => {});
				}
			}
		}

		if (result.compactionSuggested) {
			// Background compaction: starts now, survives past the response via
			// waitUntil (in dev there's no ctx, but the promise still runs to
			// completion in the Node process).
			const job = store.compactStream(ROOM_STREAM).catch(() => {});
			platform.ctx?.waitUntil?.(job);
		}

		return json(result, { status: result.outcome === 'appended' ? 201 : 200 });
	} catch (e) {
		if (e instanceof ConcurrencyError) {
			return json(
				{ message: 'Version conflict — re-read the head and retry.', headVersion: await headVersion(store) },
				{ status: 409 }
			);
		}
		if (e instanceof CommandError) throw error(e.status, e.message);
		// The append path's fail-closed rule: once a shred is requested, the
		// encrypting serializer refuses to store new personal data for that
		// subject — the append dies before any PUT.
		if (e instanceof SubjectErasedError) {
			throw error(410, 'Your account has been erased (crypto-shredded) — posting is disabled.');
		}
		throw e;
	}
};
