// Client-side "decrypt view" for the Storage and API inspector pages.
//
// The server never decrypts (model B) — the Storage view shows raw R2 bytes
// and the API browser shows raw responses, both ciphertext. These helpers let
// the BROWSER decrypt them for display, exactly as a normal reader would:
// walk a parsed JSON value, and wherever an `EncryptedField` envelope sits
// beside a `subject`, replace it with the locally decrypted plaintext (or a
// fail-closed marker when the key is gone). Uses the same keyring client and
// AAD rules as the chat, so a crypto-shredded field shows as erased here too.

import { isEncryptedField } from '$lib/crypto';
import { decryptFor } from '$lib/keyringClient';

/** Shown in place of a field whose key can't be delivered (shredded/unknown). */
export const ERASED_MARKER = '🔒 [erased — key unavailable]';

/**
 * Recursively transform a value: decrypt every encrypted field that has a
 * sibling `subject`, threading the nearest enclosing `streamId` (feed pages,
 * commit and chunk objects all carry it) so the AAD — `${streamId}|${field}` —
 * matches what encryption used. Field name is the property key.
 */
async function walk(value: unknown, streamId: string): Promise<unknown> {
	if (Array.isArray(value)) {
		return Promise.all(value.map((v) => walk(v, streamId)));
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const sid = typeof obj.streamId === 'string' ? obj.streamId : streamId;
		const subject = typeof obj.subject === 'string' ? obj.subject : null;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (subject && isEncryptedField(v)) {
				const pt = await decryptFor(subject, sid, k, v);
				out[k] = pt ?? ERASED_MARKER;
			} else {
				out[k] = await walk(v, sid);
			}
		}
		return out;
	}
	return value;
}

/**
 * Decrypt a JSON document's encrypted fields and re-render it pretty-printed.
 * Non-JSON input is returned unchanged; fields with no resolvable subject
 * (e.g. legacy events that predate the `subject` field) are left as their
 * ciphertext envelope.
 */
export async function decryptJsonText(text: string, defaultStreamId: string): Promise<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return text;
	}
	return JSON.stringify(await walk(parsed, defaultStreamId), null, 2);
}
