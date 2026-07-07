import { error, json } from '@sveltejs/kit';
import { getKeyStore } from '$lib/server/keys';
import { bytesToBase64, type WireKeyring } from '$lib/crypto';
import type { RequestHandler } from './$types';

/**
 * Keyring delivery (model B): every key generation a subject has, so the
 * browser can decrypt that author's fields locally. Addressed by SUBJECT —
 * the opaque keyed hash that events carry — because that's all a reader of
 * the log ever knows about an author. Nothing here maps back to a username;
 * the name itself is one of the encrypted fields these keys unlock.
 *
 * This endpoint is where erasure becomes visible: once a shred is requested
 * (tombstone `pending`), the library's keyring read returns EMPTY — reads
 * fail closed everywhere at once, days before the keys are hard-deleted.
 *
 * Always `no-store`: keys must never touch any cache. (Contrast with the feed
 * pages, which are cached forever precisely because they hold only ciphertext.)
 *
 * Demo caveat: any logged-in user may fetch any subject's keyring — everyone
 * can read the shared room anyway. In a real deployment keyring delivery is
 * THE read-access-control point; authorize it accordingly.
 */
export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');
	if (!/^[0-9a-f]{32}$/.test(params.subject)) {
		throw error(400, 'Not a subject id (expected 32 hex chars)');
	}

	const entries = await getKeyStore(platform.env).keyring(params.subject);

	const wire: WireKeyring = {
		keyring: entries.map((e) => ({
			keyId: e.keyId,
			key: bytesToBase64(e.key),
			expiresAt: e.expiresAt
		}))
	};
	return json(wire, { headers: { 'cache-control': 'no-store' } });
};
