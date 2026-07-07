import { error, json } from '@sveltejs/kit';
import { cancelShred } from '@jimvella/s3-event-store';
import { ensureUserId, getShredContext, readTombstone } from '$lib/server/keys';
import type { RequestHandler } from './$types';

/**
 * POST /api/shred/cancel — change your mind during the waiting period.
 * Audit-first (`ShredCancelled` is appended before the tombstone CAS), and
 * per-intent: it cancels exactly the intent currently stamped on the
 * tombstone. Once the sweeper has moved the tombstone to `committing`, the
 * point of no return has passed and cancellation reports `lost-to-commit`.
 */
export const POST: RequestHandler = async ({ platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const subject = await ensureUserId(platform.env, locals.username);
	const tombstone = await readTombstone(platform.env, subject);
	if (!tombstone || tombstone.state === 'cancelled') {
		throw error(409, 'No shred in progress for your account');
	}

	const ctx = getShredContext(platform.env);
	const outcome = await cancelShred(ctx, subject, tombstone.intent);
	const ok = outcome === 'cancelled' || outcome === 'already-cancelled';
	return json({ subject, outcome }, { status: ok ? 200 : 409 });
};
