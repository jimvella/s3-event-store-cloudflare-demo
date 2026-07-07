import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import {
	ensureUserId,
	isErased,
	legacySubjectForUsername,
	readTombstone,
	resolveUserId
} from '$lib/server/keys';
import type { Actions } from './$types';

const MAX_USERNAME = 32;

export const actions: Actions = {
	default: async ({ request, cookies, platform }) => {
		const form = await request.formData();
		const raw = form.get('username');
		const username = typeof raw === 'string' ? raw.trim() : '';

		if (!username) {
			return fail(400, { error: 'Please enter a username', username: '' });
		}
		if (username.length > MAX_USERNAME) {
			return fail(400, { error: `Username must be ${MAX_USERNAME} characters or fewer`, username });
		}

		if (platform?.env) {
			const env = platform.env;
			// A crypto-shredded identity is gone for good: the tombstone is never
			// deleted, so the username can't be reclaimed to write new personal
			// data (only the demo's bucket reset clears it). Check the subject the
			// user would resolve to today (their stored userId) AND the legacy
			// hash a pre-userId-era shred would have used — either being erased
			// burns the name.
			const existingUserId = await resolveUserId(env, username);
			const candidates = [existingUserId, await legacySubjectForUsername(env, username)].filter(
				(s): s is string => s !== null
			);
			for (const subject of candidates) {
				if (isErased(await readTombstone(env, subject))) {
					return fail(403, {
						error: 'That username has been permanently erased (crypto-shredded) and cannot be reused.',
						username
					});
				}
			}

			// Register-or-resolve the stable userId now, so the account record
			// exists before the first append reads it.
			await ensureUserId(env, username);
		}

		cookies.set('username', username, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev,
			maxAge: 60 * 60 * 24 * 30
		});

		throw redirect(303, '/');
	}
};
