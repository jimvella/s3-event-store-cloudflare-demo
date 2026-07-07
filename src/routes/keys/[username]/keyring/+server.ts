import { error, json } from '@sveltejs/kit';
import { getKeyStore, subjectForUsername } from '$lib/server/keys';
import { bytesToBase64, type WireKeyring } from '$lib/crypto';
import type { RequestHandler } from './$types';

/**
 * Keyring delivery (model B): every key generation a user has, so the browser
 * can decrypt their messages locally. Addressed by USERNAME — the server maps
 * it to the hashed key subject internally, so clients never see or compute
 * subject IDs (the hash is keyed by a server-held pepper).
 *
 * This endpoint is where erasure becomes visible: once a shred is requested
 * (tombstone `pending`), the library's keyring read returns EMPTY — reads
 * fail closed everywhere at once, days before the keys are hard-deleted.
 *
 * Always `no-store`: keys must never touch any cache. (Contrast with the feed
 * pages, which are cached forever precisely because they hold only ciphertext.)
 *
 * Demo caveat: any logged-in user may fetch any user's keyring — everyone can
 * read the shared room anyway. In a real deployment keyring delivery is THE
 * read-access-control point; authorize it accordingly.
 */
export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const subject = await subjectForUsername(platform.env, params.username);
	const entries = await getKeyStore(platform.env).keyring(subject);

	const wire: WireKeyring = {
		keyring: entries.map((e) => ({
			keyId: e.keyId,
			key: bytesToBase64(e.key),
			expiresAt: e.expiresAt
		}))
	};
	return json(wire, { headers: { 'cache-control': 'no-store' } });
};
