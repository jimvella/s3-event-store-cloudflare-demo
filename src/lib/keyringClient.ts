// Browser-side keyring client, shared by the chat and Keys pages.
//
// Keyrings are fetched per SUBJECT from `/keys/{subject}/keyring` and their
// keys imported into non-extractable WebCrypto handles, cached by keyId. A
// keyId the cached keyring doesn't know triggers ONE fresh fetch (deduped
// across concurrent misses); if the key still isn't deliverable the caller
// gets null — decryption fails closed, never stale plaintext or garbage.

import { base64ToBytes, decryptField, importAesKey, type EncryptedField, type WireKeyring } from '$lib/crypto';

const cache = new Map<string, Map<string, CryptoKey>>();
const inflight = new Map<string, Promise<Map<string, CryptoKey>>>();

/** Drop every cached keyring — a periodic refresh calls this so a shred (or
 * its cancellation) done elsewhere converges in every open tab. */
export function clearKeyCache(): void {
	cache.clear();
}

/** Fetch and import a subject's keyring, deduping concurrent calls. */
export function loadKeyring(subject: string): Promise<Map<string, CryptoKey>> {
	let p = inflight.get(subject);
	if (!p) {
		p = (async () => {
			const keys = new Map<string, CryptoKey>();
			try {
				const res = await fetch(`/keys/${encodeURIComponent(subject)}/keyring`, {
					cache: 'no-store'
				});
				if (res.ok) {
					const { keyring } = (await res.json()) as WireKeyring;
					for (const e of keyring) keys.set(e.keyId, await importAesKey(base64ToBytes(e.key)));
				}
			} catch {
				/* transient — treated as an empty keyring; the next refresh retries */
			}
			cache.set(subject, keys);
			return keys;
		})().finally(() => inflight.delete(subject));
		inflight.set(subject, p);
	}
	return p;
}

/**
 * Decrypt one encrypted field for a subject. Returns the plaintext, or null
 * when the key is undeliverable (shredded) or the ciphertext fails
 * authentication — the caller renders "erased".
 */
export async function decryptFor(
	subject: string,
	streamId: string,
	field: string,
	enc: EncryptedField
): Promise<string | null> {
	let keys = cache.get(subject) ?? (await loadKeyring(subject));
	let key = keys.get(enc.keyId);
	if (!key) {
		keys = await loadKeyring(subject); // one fresh look before giving up
		key = keys.get(enc.keyId);
	}
	if (!key) return null;
	try {
		return await decryptField(key, streamId, field, enc);
	} catch {
		return null;
	}
}
