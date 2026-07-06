import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** Require a username for everything except the login page. */
export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.username && url.pathname !== '/login') {
		throw redirect(303, '/login');
	}
	if (locals.username && url.pathname === '/login') {
		throw redirect(303, '/');
	}
	return { username: locals.username };
};
