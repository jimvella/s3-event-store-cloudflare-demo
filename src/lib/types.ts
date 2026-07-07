// Shared types between server and client.

import type { EncryptedField } from '$lib/crypto';

/** The single global chat room maps to one event stream. */
export const ROOM_STREAM = 'chat:general';

/** Event types appended to the chat stream. */
export type ChatEventType = 'MessagePosted' | 'MessageEdited' | 'MessageDeleted';

/**
 * A field as stored in the log: a plaintext string on events written before
 * encryption existed, an `EncryptedField` envelope (keyed to the author) on
 * everything since. The feed serves this verbatim — decryption is the
 * *client's* job (model B), so edge-cached pages only ever hold ciphertext.
 */
export type StoredText = string | EncryptedField;

/**
 * Events identify their author by `subject` — the keyed hash of the username
 * (HMAC under a server-held pepper), stamped by the ingress. It is the only
 * author identifier in plaintext: identifiers can't be encrypted (they route
 * key selection and authorization), so they must be non-PII by construction.
 * The human-readable `username` is an encrypted ATTRIBUTE like `text`. A raw
 * fold of the log is therefore pseudonymous by default — analytics and test
 * fixtures see opaque subjects unless they're granted keyring access — and a
 * shred erases the author's name along with their words.
 */
export interface MessagePostedData {
	messageId: string;
	subject: string;
	username: StoredText;
	text: StoredText;
}

export interface MessageEditedData {
	messageId: string;
	/** The owner's subject — stamped by the server so the encrypting
	 * serializer picks the key from the event alone, no projection state. */
	subject: string;
	text: StoredText;
}

export interface MessageDeletedData {
	messageId: string;
}

/** A message as projected from the event stream (the read model). */
export interface Message {
	id: string;
	/** Author's key subject. The server fold backfills it for events written
	 * before subjects existed (legacy plaintext usernames), so consumers can
	 * rely on it being present. */
	subject: string;
	/** Stored author name: ciphertext envelope (or legacy plaintext). */
	username: StoredText;
	/** Stored payload: ciphertext envelope (or legacy plaintext). */
	text: StoredText;
	/** Stream version of the MessagePosted event — stable ordering key. */
	seq: number;
	postedAt: string;
	editedAt: string | null;
	deleted: boolean;
}
