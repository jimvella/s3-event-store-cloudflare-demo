import { error } from '@sveltejs/kit';
import { subjectForUsername } from '$lib/server/keys';
import type { PageServerLoad } from './$types';

/** The session user's key subject, to prefill the keyring endpoint's path
 * param — clients can't compute it (the hash is keyed by a server pepper). */
export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!platform?.env) throw error(500, 'R2 binding unavailable — is wrangler configured?');
	return { mySubject: await subjectForUsername(platform.env, locals.username!) };
};
