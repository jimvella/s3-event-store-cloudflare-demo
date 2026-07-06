import { error } from '@sveltejs/kit';
import { foldRoom, getStore } from '$lib/server/store';
import type { PageServerLoad } from './$types';

/** Initial render: the full projection of the chat stream plus a cursor. */
export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!platform?.env) {
		throw error(500, 'R2 binding unavailable — is wrangler configured?');
	}
	const store = getStore(platform.env);
	const { messages, cursor } = await foldRoom(store);
	return { username: locals.username, messages, cursor };
};
