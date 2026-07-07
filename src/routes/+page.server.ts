import { error } from '@sveltejs/kit';
import { foldRoom, getStore } from '$lib/server/store';
import { subjectForUsername } from '$lib/server/keys';
import type { PageServerLoad } from './$types';

/** Initial render: the full projection of the chat stream plus a cursor.
 * Message names/texts are ciphertext — the browser decrypts. `mySubject` lets
 * the client recognize its own messages without decrypting anything. */
export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!platform?.env) {
		throw error(500, 'R2 binding unavailable — is wrangler configured?');
	}
	const store = getStore(platform.env);
	const { messages, cursor } = await foldRoom(store, platform.env);
	return {
		username: locals.username,
		mySubject: await subjectForUsername(platform.env, locals.username!),
		messages,
		cursor
	};
};
