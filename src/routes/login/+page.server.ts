import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';

const MAX_USERNAME = 32;

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const raw = form.get('username');
		const username = typeof raw === 'string' ? raw.trim() : '';

		if (!username) {
			return fail(400, { error: 'Please enter a username', username: '' });
		}
		if (username.length > MAX_USERNAME) {
			return fail(400, { error: `Username must be ${MAX_USERNAME} characters or fewer`, username });
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
