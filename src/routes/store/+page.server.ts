import { error } from '@sveltejs/kit';
import { listObjects } from '$lib/server/browser';
import type { PageServerLoad } from './$types';

/** Initial render: the list of objects (files) in the R2 bucket. */
export const load: PageServerLoad = async ({ platform }) => {
	if (!platform?.env) {
		throw error(500, 'R2 binding unavailable — is wrangler configured?');
	}
	return { objects: await listObjects(platform.env.EVENTS) };
};
