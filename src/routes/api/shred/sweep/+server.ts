import { error, json } from '@sveltejs/kit';
import { sweepShreds } from '@jimvella/s3-event-store';
import { getShredContext } from '$lib/server/keys';
import type { RequestHandler } from './$types';

/**
 * POST /api/shred/sweep — run the shred sweeper, the one clock-driven job in
 * the whole system. It scans `$system.key-audit` from its checkpoint
 * (`keystore/sweep/checkpoint.json`) for open intents and drives each to
 * completion: still inside the waiting period → reported in `openSubjects`,
 * untouched; past it → tombstone CAS to `committing`, key objects hard-deleted,
 * `ShredCompleted` appended. Idempotent under resume and safe to fire sloppily.
 *
 * A real deployment runs this on a cron trigger; the demo makes it a button so
 * the state machine is something you can poke and watch.
 */
export const POST: RequestHandler = async ({ platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const report = await sweepShreds(getShredContext(platform.env));
	return json(report);
};
