import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import { isErased, readTombstone, subjectForUsername } from '$lib/server/keys';
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

		// A crypto-shredded identity is gone for good: its tombstone is never
		// deleted, so the username can't be reclaimed to write new personal data
		// (only the demo's bucket reset clears it).
		if (platform?.env) {
			const subject = await subjectForUsername(platform.env, username);
			if (isErased(await readTombstone(platform.env, subject))) {
				return fail(403, {
					error: 'That username has been permanently erased (crypto-shredded) and cannot be reused.',
					username
				});
			}
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
