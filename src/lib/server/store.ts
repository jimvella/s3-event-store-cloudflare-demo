// Server-side event-store wiring, projection, and raw-append ingress.
//
// This is the heart of the demo: the chat is a single append-only event
// stream living in an R2 bucket, and everything the UI shows is a *projection*
// (fold) of that stream. Editing and deleting are themselves events, so the
// full history is always preserved.
//
// Write model: clients author the events (with a stable `id` = idempotency
// key) and submit them here. The server authorizes them against the current
// state, then appends with `idempotentAppend`, which makes a client's retry of
// a lost response safe under optimistic concurrency (DESIGN.md, raw ingress).

import {
	createEventStore,
	idempotentAppend,
	type EventEnvelope,
	type EventInput,
	type EventStore
} from '@jimvella/s3-event-store';
import { r2BindingDriver, type R2BucketLike } from '@jimvella/s3-event-store/drivers/r2-binding';
import type {
	ChatEventType,
	Message,
	MessageDeletedData,
	MessageEditedData,
	MessagePostedData
} from '$lib/types';

/** The single global chat room maps to one event stream. */
export const ROOM_STREAM = 'chat:general';

/**
 * The store's chunk width N. Tiny so the demo shows several feed pages over a
 * handful of events. HTTP feed pages are a deterministic function of the
 * version aligned to N, so `readPage`/`readHead` default their page size to
 * `store.chunkSize` — set it here once and every page boundary aligns to it.
 */
export const CHUNK_SIZE = 5;

const MAX_MESSAGE_LENGTH = 2000;

/** An error carrying an HTTP status, thrown by command handlers. */
export class CommandError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'CommandError';
	}
}

/** Build an EventStore backed by the Worker's R2 binding. */
export function getStore(env: App.Platform['env']): EventStore {
	return createEventStore({
		// A real R2Bucket satisfies the driver's structural R2BucketLike.
		driver: r2BindingDriver(env.EVENTS as unknown as R2BucketLike),
		prefix: 'chat',
		chunkSize: CHUNK_SIZE
	});
}

// ---------------------------------------------------------------------------
// Projection (read model)
// ---------------------------------------------------------------------------

/** Apply a single event to the in-progress message map. */
function applyEvent(map: Map<string, Message>, e: EventEnvelope): void {
	const ts = e.meta?.ts ?? '';
	switch (e.type as ChatEventType) {
		case 'MessagePosted': {
			const d = e.data as MessagePostedData;
			map.set(d.messageId, {
				id: d.messageId,
				username: d.username,
				text: d.text,
				seq: e.version,
				postedAt: ts,
				editedAt: null,
				deleted: false
			});
			break;
		}
		case 'MessageEdited': {
			const d = e.data as MessageEditedData;
			const m = map.get(d.messageId);
			if (m && !m.deleted) {
				m.text = d.text;
				m.editedAt = ts;
			}
			break;
		}
		case 'MessageDeleted': {
			const d = e.data as MessageDeletedData;
			const m = map.get(d.messageId);
			if (m) {
				m.deleted = true;
				m.text = '';
			}
			break;
		}
	}
}

/** Fold the whole stream into the current list of messages plus a cursor. */
export async function foldRoom(store: EventStore): Promise<{ messages: Message[]; cursor: number }> {
	const map = new Map<string, Message>();
	let maxVersion = -1;
	for await (const e of store.read(ROOM_STREAM)) {
		maxVersion = e.version;
		applyEvent(map, e);
	}
	const messages = [...map.values()].sort((a, b) => a.seq - b.seq);
	return { messages, cursor: maxVersion + 1 };
}


// ---------------------------------------------------------------------------
// Commands (write model)
// ---------------------------------------------------------------------------

const KNOWN_TYPES = new Set<ChatEventType>(['MessagePosted', 'MessageEdited', 'MessageDeleted']);

function validateText(text: unknown): string {
	if (typeof text !== 'string') throw new CommandError(400, 'Message text is required');
	const clean = text.trim();
	if (!clean) throw new CommandError(400, 'Message cannot be empty');
	if (clean.length > MAX_MESSAGE_LENGTH) {
		throw new CommandError(400, `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
	}
	return clean;
}

/** The submitted message must exist and belong to `username`. */
function requireOwn(state: Map<string, Message>, messageId: unknown, username: string): Message {
	if (typeof messageId !== 'string' || !messageId) throw new CommandError(400, 'messageId is required');
	const m = state.get(messageId);
	if (!m) throw new CommandError(404, 'Message not found');
	if (m.username !== username) throw new CommandError(403, 'You can only modify your own messages');
	return m;
}

/**
 * Authorize and normalize one client-submitted event against the working state,
 * returning the `EventInput` to append. `state` is mutated so that later events
 * in the same batch see the effect of earlier ones.
 *
 * Note we deliberately do NOT reject "terminal" conditions a successful commit
 * would itself create (a messageId that now exists, an already-deleted message):
 * those would turn an idempotent *retry* — whose event is already committed —
 * into a spurious 409. `idempotentAppend` is the authority on duplicates; the
 * checks here are purely authorization + shape, all stable across a retry.
 */
function authorizeEvent(raw: unknown, username: string, state: Map<string, Message>): EventInput {
	if (!raw || typeof raw !== 'object') throw new CommandError(400, 'Each event must be an object');
	const { id, type, data } = raw as { id?: unknown; type?: unknown; data?: unknown };

	if (typeof id !== 'string' || !id) {
		throw new CommandError(400, 'Each event needs a stable string `id` (the idempotency key)');
	}
	if (typeof type !== 'string' || !KNOWN_TYPES.has(type as ChatEventType)) {
		throw new CommandError(400, `Unknown event type: ${String(type)}`);
	}
	const d = (data ?? {}) as Record<string, unknown>;

	if (type === 'MessagePosted') {
		if (d.username !== username) throw new CommandError(403, 'You cannot post as another user');
		if (typeof d.messageId !== 'string' || !d.messageId) throw new CommandError(400, 'messageId is required');
		const text = validateText(d.text);
		state.set(d.messageId, {
			id: d.messageId,
			username,
			text,
			seq: -1,
			postedAt: '',
			editedAt: null,
			deleted: false
		});
		return { id, type, data: { messageId: d.messageId, username, text } };
	}

	if (type === 'MessageEdited') {
		const m = requireOwn(state, d.messageId, username);
		if (m.deleted) throw new CommandError(409, 'Cannot edit a deleted message');
		const text = validateText(d.text);
		m.text = text;
		return { id, type, data: { messageId: m.id, text } };
	}

	// MessageDeleted
	const m = requireOwn(state, d.messageId, username);
	m.deleted = true;
	return { id, type, data: { messageId: m.id } };
}

export interface AppendOutcome {
	outcome: 'appended' | 'alreadyCommitted';
	nextExpectedVersion: number;
	/**
	 * The library's write-driven compaction trigger: true when this append sealed
	 * an uncompacted bucket behind the head. The endpoint fires
	 * `compactStream` on it via `waitUntil`. Never set on the alreadyCommitted
	 * path (the original attempt already fired it).
	 */
	compactionSuggested: boolean;
}

/**
 * Raw-append ingress: authorize client-built events against current state, then
 * append idempotently at the client's `expectedVersion`. Throws `CommandError`
 * for bad/unauthorized input; lets `ConcurrencyError` propagate (the endpoint
 * maps it to 409 so the client can re-read the head and retry the same events).
 */
export async function appendEvents(
	store: EventStore,
	username: string,
	events: unknown,
	expectedVersion: number | 'noStream'
): Promise<AppendOutcome> {
	if (!Array.isArray(events) || events.length === 0) {
		throw new CommandError(400, '`events` must be a non-empty array');
	}
	// Fold once to a working state, then authorize each event against it.
	const { messages } = await foldRoom(store);
	const state = new Map(messages.map((m) => [m.id, { ...m }]));
	const inputs = events.map((e) => authorizeEvent(e, username, state));

	const res = await idempotentAppend(store, ROOM_STREAM, inputs, { expectedVersion });
	return res.outcome === 'appended'
		? {
				outcome: 'appended',
				nextExpectedVersion: res.result.nextExpectedVersion,
				compactionSuggested: res.result.compactionSuggested
			}
		: {
				outcome: 'alreadyCommitted',
				nextExpectedVersion: res.nextExpectedVersion,
				compactionSuggested: false
			};
}

/** Current head version of the room stream, or -1 if the stream is empty. */
export async function headVersion(store: EventStore): Promise<number> {
	const head = await store.resolveHead(ROOM_STREAM);
	return head.kind === 'head' ? head.version : -1;
}

// ---------------------------------------------------------------------------
// Edge cache (Cloudflare `caches.default`)
// ---------------------------------------------------------------------------
//
// Complete feed pages are immutable, so we actually store them in the edge
// cache — the "immutable" header becomes a real cache hit, not just a promise.
// `caches.default` only exists in the Workers runtime; in `vite dev` it's
// undefined and the feed simply skips caching.

export interface EdgeCache {
	match(key: Request): Promise<Response | undefined>;
	put(key: Request, res: Response): Promise<void>;
	delete(key: Request | string): Promise<boolean>;
}

export function edgeCache(): EdgeCache | undefined {
	return (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
}

/**
 * Canonical edge-cache key for a feed page — normalized so every client shares
 * one entry regardless of how it encoded the stream id in the URL.
 */
export function feedPageCacheKey(origin: string, stream: string, from: number): Request {
	return new Request(`${origin}/streams/${encodeURIComponent(stream)}/events?from=${from}`);
}

/**
 * The head response's own edge-cache keys — both URL encodings a client might
 * request (the app uses the %3A-encoded stream id; the API browser uses the raw
 * colon), since the edge caches each under its own key. Appends purge these so a
 * new head shows up within a poll interval rather than up to the 1s TTL late.
 */
export function headResponseCacheKeys(origin: string, stream: string): string[] {
	return [
		`${origin}/streams/${encodeURIComponent(stream)}/head`,
		`${origin}/streams/${stream}/head`
	];
}
