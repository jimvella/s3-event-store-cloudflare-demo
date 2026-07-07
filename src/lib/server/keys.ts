// Key management for field-level encryption + crypto-shredding.
//
// Everything here is the library's shipped key layer (`createS3KeyStore`,
// `aesMasterKey`, the requestShred/cancelShred/sweepShreds workflow) — the
// demo only decides *where it lives* and *what a subject is*:
//
//  - WHERE: under the `keystore/` prefix of the SAME R2 bucket as the events,
//    via a small prefix-rebasing driver wrapper. KEYS_DESIGN.md wants the key
//    store in a separately-configured bucket (no versioning, delete permission
//    held by the sweeper's principal alone); one Worker binding can't express
//    that IAM split, so a demo shares the bucket and documents the difference.
//    Resulting layout (all visible in the Storage view):
//
//      keystore/keys/{subject}/{gen:06d}.json   wrapped data keys, one per generation
//      keystore/tombstones/{subject}.json       shred state machine
//      keystore/sweep/checkpoint.json           the sweeper's audit-stream cursor
//
//  - WHAT: a subject is a chat user, identified by a stable random `userId`
//    minted at first login and STORED in a user directory (see below), the way
//    a real app keeps it as a column on the account row. It must be stable for
//    life (it names the key hierarchy, tombstone, and every event the user
//    wrote) and non-PII (identifiers in object keys and audit events live
//    forever outside the encryption boundary) — a hash of the mutable,
//    low-entropy username satisfies neither, so we store a random id instead.

import {
	AUDIT_STREAM,
	aesMasterKey,
	createEventStore,
	createS3KeyStore,
	tombstoneKey,
	type EventStore,
	type KeyStore,
	type ShredContext,
	type StorageDriver,
	type Tombstone
} from '@jimvella/s3-event-store';
import { r2BindingDriver, type R2BucketLike } from '@jimvella/s3-event-store/drivers/r2-binding';
import { CHUNK_SIZE } from '$lib/server/store';

/** Everything the key layer writes sits under this prefix in the event bucket. */
export const KEYSTORE_PREFIX = 'keystore/';

type Env = App.Platform['env'];

// Demo fallbacks so `npm run dev` works with zero setup. A real deployment
// must set both as Worker secrets (see README) — the master key wraps every
// data key, and the pepper is what keeps subject IDs non-reversible.
const DEV_MASTER_KEY_UTF8 = 's3-event-store-demo-master-key!!'; // exactly 32 bytes
const DEV_SUBJECT_PEPPER = 's3-event-store-demo-pepper';

/** Soft-delete waiting period before a shred's hard delete. Production wants
 * days (a real GDPR flow gives the user time to change their mind); the demo
 * defaults to 60s so the full lifecycle fits in one sitting. */
export function shredWaitingPeriodMs(env: Env): number {
	const raw = env.SHRED_WAITING_PERIOD_MS;
	const ms = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
	return Number.isFinite(ms) && ms >= 0 ? ms : 60_000;
}

function masterKeySecret(env: Env): Uint8Array {
	if (env.MASTER_KEY_SECRET) {
		const bytes = Uint8Array.from(atob(env.MASTER_KEY_SECRET), (c) => c.charCodeAt(0));
		if (bytes.length !== 32) throw new Error('MASTER_KEY_SECRET must be 32 bytes of base64');
		return bytes;
	}
	return new TextEncoder().encode(DEV_MASTER_KEY_UTF8);
}

/**
 * Rebase a StorageDriver under a key prefix: the wrapped driver sees a bucket
 * whose root is `prefix`. `list` results are rebased back, so callers (the
 * key store, the sweeper) never observe the prefix — the same trick that lets
 * unrelated stores share one bucket.
 */
export function prefixedDriver(inner: StorageDriver, prefix: string): StorageDriver {
	const add = (key: string) => prefix + key;
	const strip = (key: string) => (key.startsWith(prefix) ? key.slice(prefix.length) : key);
	return {
		get: (key, opts) => inner.get(add(key), opts),
		put: (key, body) => inner.put(add(key), body),
		putIfAbsent: (key, body) => inner.putIfAbsent(add(key), body),
		putIfMatch: (key, body, etag) => inner.putIfMatch(add(key), body, etag),
		delete: (key) => inner.delete(add(key)),
		deleteMany: (keys) => inner.deleteMany(keys.map(add)),
		list: async (listPrefix, opts) => {
			const page = await inner.list(add(listPrefix), {
				...opts,
				startAfter: opts?.startAfter === undefined ? undefined : add(opts.startAfter)
			});
			return {
				keys: page.keys.map((k) => ({ ...k, key: strip(k.key) })),
				...(page.nextStartAfter === undefined
					? {}
					: { nextStartAfter: strip(page.nextStartAfter) })
			};
		}
	};
}

/** Driver over the key-management subtree of the event bucket. */
export function getKeyDriver(env: Env): StorageDriver {
	return prefixedDriver(r2BindingDriver(env.EVENTS as unknown as R2BucketLike), KEYSTORE_PREFIX);
}

// ---------------------------------------------------------------------------
// User directory: username → stable userId
// ---------------------------------------------------------------------------
//
// The key subject must be STABLE FOR LIFE — it names the key hierarchy, the
// tombstone, and every event the user ever wrote — while a username is a
// mutable, low-entropy attribute. So the subject is a random `userId` minted
// once at first login and STORED, the way a real app keeps it as a column on
// the account record; login does a lookup, not a derivation. The directory
// record is the demo's stand-in for that account row:
//
//   users/{hmac(pepper, username)}.json  →  { "userId": "<32 hex>", "createdAt": … }
//
// The record's object key is a keyed hash (identifiers in object keys live
// forever and must not be PII) and its body holds NO username: the only place
// a name exists is encrypted inside events, so erasure covers it. The pepper
// here only protects the login index — losing it strands the username→userId
// mapping (returning users would mint fresh identities), but unlike a
// derived-subject scheme it cannot orphan keys or ciphertext: events carry
// their subject verbatim.

/** Login-index key: hex(HMAC-SHA-256(pepper, username))[0..32). Keyed, so the
 * directory's object keys don't disclose usernames even by dictionary. */
async function usernameIndexHash(env: Env, username: string): Promise<string> {
	const pepper = new TextEncoder().encode(env.SUBJECT_PEPPER ?? DEV_SUBJECT_PEPPER);
	const key = await crypto.subtle.importKey(
		'raw',
		pepper as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username))
	);
	return [...mac]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

/** Driver over the user directory ('users/' prefix of the event bucket). */
function userDirectory(env: Env): StorageDriver {
	return prefixedDriver(r2BindingDriver(env.EVENTS as unknown as R2BucketLike), 'users/');
}

/** The stored userId for a username, or null if never registered. */
export async function resolveUserId(env: Env, username: string): Promise<string | null> {
	const got = await userDirectory(env).get(`${await usernameIndexHash(env, username)}.json`);
	return got.kind === 'found' ? (JSON.parse(got.body) as { userId: string }).userId : null;
}

/**
 * Register-or-resolve at login: mint a random 128-bit userId and claim the
 * directory record with a create-only PUT. Two concurrent first logins race
 * safely — the loser's `putIfAbsent` reports `exists` and re-reads the
 * winner's record, so a username can never map to two identities.
 */
export async function ensureUserId(env: Env, username: string): Promise<string> {
	const dir = userDirectory(env);
	const recordKey = `${await usernameIndexHash(env, username)}.json`;

	const existing = await dir.get(recordKey);
	if (existing.kind === 'found') return (JSON.parse(existing.body) as { userId: string }).userId;

	const userId = [...crypto.getRandomValues(new Uint8Array(16))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const put = await dir.putIfAbsent(recordKey, JSON.stringify({ userId, createdAt: new Date().toISOString() }));
	if (put.kind === 'created') return userId;

	const won = await dir.get(recordKey);
	if (won.kind !== 'found') throw new Error('user record vanished during registration race');
	return (JSON.parse(won.body) as { userId: string }).userId;
}

/**
 * LEGACY COMPAT: subjects used to be derived directly as hmac(username), so
 * shreds from that era left their tombstones under the hash. Login checks it
 * too, so a username burned before the userId migration stays burned.
 */
export async function legacySubjectForUsername(env: Env, username: string): Promise<string> {
	return usernameIndexHash(env, username);
}

/**
 * Event store handle for the reserved `$system.key-audit` stream — the same
 * bucket and prefix as the chat stream, but with reserved (`$`-prefixed)
 * stream IDs enabled. The public feed/head routes keep rejecting them; only
 * the key layer writes here.
 */
export function getAuditStore(env: Env): EventStore {
	return createEventStore({
		driver: r2BindingDriver(env.EVENTS as unknown as R2BucketLike),
		prefix: 'chat',
		chunkSize: CHUNK_SIZE,
		allowReservedStreams: true
	});
}

/**
 * The library's S3-bucket KeyStore over the `keystore/` prefix. TTLs are
 * demo-short so a shred's instant-unreadability is visible within seconds
 * (production trades longer TTLs for fewer tombstone reads). Key mint and
 * rotation events land on the audit stream via the audit hook.
 */
export function getKeyStore(env: Env): KeyStore {
	const auditStore = getAuditStore(env);
	return createS3KeyStore({
		driver: getKeyDriver(env),
		masterKey: aesMasterKey(masterKeySecret(env)),
		keyCacheTtlMs: 5_000,
		tombstoneTtlMs: 5_000,
		keyringTtlMs: 30_000,
		audit: async (type, data) => {
			await auditStore.append(AUDIT_STREAM, [{ type, data }], { expectedVersion: 'any' });
		}
	});
}

/** Context for the shred workflow (requestShred / cancelShred / sweepShreds). */
export function getShredContext(env: Env): ShredContext {
	return {
		auditStore: getAuditStore(env),
		keyDriver: getKeyDriver(env),
		waitingPeriodMs: shredWaitingPeriodMs(env)
	};
}

/** Read a subject's shred tombstone, or null if none was ever created. */
export async function readTombstone(env: Env, subject: string): Promise<Tombstone | null> {
	const got = await getKeyDriver(env).get(tombstoneKey(subject));
	return got.kind === 'found' ? (JSON.parse(got.body) as Tombstone) : null;
}

/** True when the subject is soft-deleted: shredding requested or under way. */
export function isErased(tombstone: Tombstone | null): boolean {
	return tombstone !== null && (tombstone.state === 'pending' || tombstone.state === 'committing');
}
