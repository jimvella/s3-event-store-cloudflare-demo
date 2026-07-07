import { error, json } from '@sveltejs/kit';
import { requestShred } from '@jimvella/s3-event-store';
import { ensureUserId, getShredContext } from '$lib/server/keys';
import type { RequestHandler } from './$types';

/**
 * POST /api/shred — request crypto-shredding of YOUR OWN account (the GDPR
 * erasure flow). The library's `requestShred` performs steps 1–2 of the
 * protocol: append a `ShredRequested` intent to `$system.key-audit`, then
 * write the tombstone (`pending`). From that moment the subject is
 * soft-deleted — keyring delivery returns empty (messages render as erased)
 * and appends fail closed — but nothing is destroyed yet: the sweeper
 * executes the hard delete only after the waiting period.
 *
 * Fire it twice: the second call takes over the same tombstone with a newer
 * intent — idempotent by construction, never a second state machine.
 */
export const POST: RequestHandler = async ({ platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const ctx = getShredContext(platform.env);
	const subject = await ensureUserId(platform.env, locals.username);
	const { intentPosition } = await requestShred(ctx, subject);

	return json(
		{
			subject,
			intentPosition,
			state: 'pending',
			waitingPeriodMs: ctx.waitingPeriodMs,
			note: 'Soft-deleted: keys are undeliverable now; hard delete happens when the sweeper runs after the waiting period. Cancel with POST /api/shred/cancel.'
		},
		{ status: 202 }
	);
};
