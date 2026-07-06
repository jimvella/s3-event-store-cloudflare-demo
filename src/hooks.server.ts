import type { Handle } from '@sveltejs/kit';

/** Read the username cookie into locals for every request. No real auth. */
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.username = event.cookies.get('username') ?? null;
	return resolve(event);
};
