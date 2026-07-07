import { error, json } from '@sveltejs/kit';
import { SubjectErasedError } from '@jimvella/s3-event-store';
import { getKeyStore, subjectForUsername } from '$lib/server/keys';
import type { RequestHandler } from './$types';

/**
 * POST /api/keys/rotate — mint the next key generation for your own account.
 * Old generations stay in the keyring, so existing messages keep decrypting;
 * only new encryptions use the new key. Watch the per-field `keyId` change on
 * messages posted after a rotation, and the `KeyRotated` audit event land on
 * `$system.key-audit`.
 */
export const POST: RequestHandler = async ({ platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const subject = await subjectForUsername(platform.env, locals.username);
	try {
		const { keyId } = await getKeyStore(platform.env).rotate(subject);
		return json({ subject, keyId });
	} catch (e) {
		if (e instanceof SubjectErasedError) {
			throw error(410, 'Your account has been erased (crypto-shredded) — no new keys.');
		}
		throw e;
	}
};
