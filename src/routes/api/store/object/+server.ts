import { error, json } from '@sveltejs/kit';
import { getObjectBody } from '$lib/server/browser';
import type { RequestHandler } from './$types';

/** GET /api/store/object?key=<key> — one object's verbatim contents. */
export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.username) throw error(401, 'Not logged in');
	if (!platform?.env) throw error(500, 'R2 binding unavailable');

	const key = url.searchParams.get('key');
	if (!key) throw error(400, 'Missing key');

	const body = await getObjectBody(platform.env.EVENTS, key);
	if (!body) throw error(404, 'Object not found');
	return json(body);
};
