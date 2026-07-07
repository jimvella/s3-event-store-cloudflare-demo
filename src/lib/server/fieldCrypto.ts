// A field-level encrypting serializer on the library's public
// `PayloadSerializer` seam.
//
// The library ships a *whole-payload* encrypting serializer whose subject is a
// function of the STREAM (`subjectFor(streamId)`) — the right shape when each
// stream belongs to one owner. This chat is the other shape: one shared stream
// with many authors, so the subject must come from the EVENT, and only the
// sensitive fields are encrypted — `username` and `messageId` stay plaintext
// so authorization and projection never need a key. Shredding one author then
// erases exactly their words and nothing else.
//
// Two deliberate asymmetries against the library's serializer:
//
//  - `serialize` encrypts (fail closed: `currentKey` throws SubjectErasedError
//    for a soft-deleted subject, so an erased user cannot write new personal
//    data — KEYS_DESIGN.md's append-path rule).
//  - `deserialize` is a PASSTHROUGH. Decryption belongs to the browser
//    (model B): feed pages are edge-cached `immutable`, so whatever the server
//    serves is cached forever — it must be ciphertext, or a shred would leave
//    stale plaintext at the edge. The server never holds a decrypt path at all.

import type { KeyStore, PayloadSerializer, SerializedPayload } from '@jimvella/s3-event-store';
import { encryptField, importAesKey } from '$lib/crypto';

export interface FieldEncryptingConfig {
	keys: KeyStore;
	/**
	 * Map an event to its key subject (the erasure unit), or null to store the
	 * event in plaintext. The event-level analogue of the library's
	 * per-stream `subjectFor` — the application contract that every event
	 * carrying a subject's personal data resolves to that subject.
	 */
	subjectFor(event: { type: string; data: unknown }): Promise<string | null> | string | null;
	/** Which `data` fields to encrypt, per event type. Absent type ⇒ plaintext. */
	encryptedFields: Record<string, string[]>;
}

export function fieldEncryptingSerializer(config: FieldEncryptingConfig): PayloadSerializer {
	return {
		async serialize(streamId, event): Promise<SerializedPayload> {
			const fields = config.encryptedFields[event.type] ?? [];
			if (fields.length === 0) return { data: event.data };

			const subject = await config.subjectFor(event);
			if (subject === null) return { data: event.data };

			// Newest generation for this subject; lazily mints generation 0 on a
			// user's first message. Throws SubjectErasedError once shredding has
			// been requested — the append fails closed before anything is stored.
			const { keyId, key: raw } = await config.keys.currentKey(subject);
			const key = await importAesKey(raw);

			const data = { ...(event.data as Record<string, unknown>) };
			for (const field of fields) {
				const value = data[field];
				if (typeof value !== 'string') continue;
				data[field] = await encryptField(key, keyId, streamId, field, value);
			}
			// Stamp the envelope's reserved keyId too — the generation that
			// encrypted this event, stored verbatim and never re-encrypted.
			return { data, keyId };
		},

		// Ciphertext out, verbatim — see the model-B note above.
		async deserialize(_streamId, envelope) {
			return envelope.data;
		}
	};
}
