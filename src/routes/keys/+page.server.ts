import { error } from '@sveltejs/kit';
import { AUDIT_STREAM, generationKey, type Tombstone } from '@jimvella/s3-event-store';
import { foldRoom, getStore } from '$lib/server/store';
import {
	getAuditStore,
	getKeyDriver,
	KEYSTORE_PREFIX,
	readTombstone,
	shredWaitingPeriodMs,
	subjectForUsername
} from '$lib/server/keys';
import type { PageServerLoad } from './$types';

export interface KeyGeneration {
	keyId: string;
	createdAt: string;
	/** Leading bytes of the WRAPPED key (base64) — safe to show: it is
	 * ciphertext under the master key, which is the point of key wrapping. */
	wrappedKeyPreview: string;
	/** Where this generation lives in the bucket (see it in the Storage view). */
	objectKey: string;
}

export interface SubjectInfo {
	username: string;
	/** The hashed key subject: HMAC-SHA-256(pepper, username), truncated. */
	subject: string;
	generations: KeyGeneration[];
	tombstone: Tombstone | null;
}

export interface AuditEntry {
	version: number;
	type: string;
	subjectId: string;
	ts: string;
}

/**
 * The Keys lens: every chat author's key hierarchy (subjects appear once
 * they've posted — generation 0 is minted lazily by the first encrypt), the
 * shred tombstones, and the `$system.key-audit` stream. All of it read from
 * the same R2 bucket the Storage view lists raw.
 */
export const load: PageServerLoad = async ({ platform, locals }) => {
	if (!platform?.env) throw error(500, 'R2 binding unavailable — is wrangler configured?');
	const env = platform.env;
	const me = locals.username!;

	// Authors come from the projection; always include the session user so the
	// page has a "my account" card even before their first message.
	const { messages } = await foldRoom(getStore(env));
	const usernames = [...new Set([me, ...messages.map((m) => m.username)])];

	const keyDriver = getKeyDriver(env);
	const subjects: SubjectInfo[] = await Promise.all(
		usernames.map(async (username) => {
			const subject = await subjectForUsername(env, username);
			const listed = await keyDriver.list(`keys/${subject}/`);
			const generations = await Promise.all(
				listed.keys.map(async ({ key }) => {
					const got = await keyDriver.get(key);
					const body =
						got.kind === 'found'
							? (JSON.parse(got.body) as { keyId: string; wrappedKey: string; createdAt: string })
							: null;
					return {
						keyId: body?.keyId ?? key.replace(/^.*\/(.*)\.json$/, '$1'),
						createdAt: body?.createdAt ?? '',
						wrappedKeyPreview: body ? `${body.wrappedKey.slice(0, 24)}…` : '',
						objectKey: KEYSTORE_PREFIX + key
					};
				})
			);
			return { username, subject, generations, tombstone: await readTombstone(env, subject) };
		})
	);

	// The audit stream is reserved ($-prefixed): readable only through the
	// audit store handle — the public feed route keeps rejecting it.
	const audit: AuditEntry[] = [];
	try {
		for await (const e of getAuditStore(env).read(AUDIT_STREAM)) {
			const d = e.data as { subjectId?: string };
			audit.push({
				version: e.version,
				type: e.type,
				subjectId: d?.subjectId ?? '',
				ts: e.meta?.ts ?? ''
			});
		}
	} catch {
		/* stream doesn't exist yet — no key activity so far */
	}

	return {
		me,
		subjects,
		audit,
		waitingPeriodMs: shredWaitingPeriodMs(env),
		now: Date.now(),
		auditStreamKey: `chat/streams/${AUDIT_STREAM}`,
		exampleGenerationKey: KEYSTORE_PREFIX + generationKey('<subject>', 0)
	};
};
