// Field-level encryption primitives, shared by the server (encrypt at append
// ingress) and the browser (decrypt for display). WebCrypto only, so the same
// code runs in Cloudflare Workers and every browser.
//
// This is the demo's model-B ("client-decrypted") wire unit: an encrypted
// *field* travels inside the event's `data` in place of the plaintext string.
// Everything around it — event type, messageId, username — stays plaintext, so
// authorization and projection keep working while the sensitive value is
// ciphertext keyed to its author. The upstream library ships a *whole-payload*
// encrypting serializer; this field-level layer is demo-owned, built on the
// library's public `PayloadSerializer` seam and `KeyStore`.

/** An encrypted field value, stored in place of the plaintext string. */
export interface EncryptedField {
	/** Marker + algorithm. Fixed; lets readers cheaply detect ciphertext. */
	$enc: 'AES-256-GCM';
	/** Key generation that encrypted this field (the library's `keyIdOf(gen)`). */
	keyId: string;
	/** 96-bit nonce, base64. Fresh and random per encryption — never reused. */
	iv: string;
	/** Ciphertext + GCM tag, base64. */
	ct: string;
}

export function isEncryptedField(v: unknown): v is EncryptedField {
	if (typeof v !== 'object' || v === null) return false;
	const f = v as Partial<EncryptedField>;
	return (
		f.$enc === 'AES-256-GCM' &&
		typeof f.keyId === 'string' &&
		typeof f.iv === 'string' &&
		typeof f.ct === 'string'
	);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Import a raw 32-byte data key for AES-GCM use. */
export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

/**
 * AAD binds the ciphertext to where it is allowed to live: the same bytes must
 * be presented at decryption, so an envelope spliced into another stream or
 * field fails authentication instead of decrypting somewhere it shouldn't.
 */
function aad(streamId: string, field: string): Uint8Array {
	return new TextEncoder().encode(`${streamId}|${field}`);
}

/** Encrypt one field value. 96-bit random nonce, fresh per call (GCM rule). */
export async function encryptField(
	key: CryptoKey,
	keyId: string,
	streamId: string,
	field: string,
	plaintext: string
): Promise<EncryptedField> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(streamId, field) as BufferSource },
		key,
		new TextEncoder().encode(plaintext)
	);
	return {
		$enc: 'AES-256-GCM',
		keyId,
		iv: bytesToBase64(iv),
		ct: bytesToBase64(new Uint8Array(ct))
	};
}

/**
 * Decrypt one field value. Throws on a wrong key or tampered/spliced
 * ciphertext — callers treat failure as "erased" (fail closed, never
 * plaintext-shaped garbage).
 */
export async function decryptField(
	key: CryptoKey,
	streamId: string,
	field: string,
	enc: EncryptedField
): Promise<string> {
	const pt = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: base64ToBytes(enc.iv) as BufferSource,
			additionalData: aad(streamId, field) as BufferSource
		},
		key,
		base64ToBytes(enc.ct) as BufferSource
	);
	return new TextDecoder().decode(pt);
}

/** The wire shape of `GET /keys/{username}/keyring` (mirrors the library's
 * browser-client keyring format: base64 keys + delivery TTL). */
export interface WireKeyring {
	keyring: { keyId: string; key: string; expiresAt: string }[];
}
