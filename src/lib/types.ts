// Shared types between server and client.

import type { EncryptedField } from '$lib/crypto';

/** Event types appended to the chat stream. */
export type ChatEventType = 'MessagePosted' | 'MessageEdited' | 'MessageDeleted';

/**
 * Message text as stored in the log: a plaintext string on events written
 * before encryption existed, an `EncryptedField` envelope (keyed to the
 * author) on everything since. The feed serves this verbatim — decryption is
 * the *client's* job (model B), so edge-cached pages only ever hold ciphertext.
 */
export type StoredText = string | EncryptedField;

export interface MessagePostedData {
	messageId: string;
	username: string;
	text: StoredText;
}

export interface MessageEditedData {
	messageId: string;
	/**
	 * The message owner — stamped by the server so the event is
	 * self-describing: the encrypting serializer derives the key subject from
	 * the event alone, with no projection state.
	 */
	username: string;
	text: StoredText;
}

export interface MessageDeletedData {
	messageId: string;
}

/** A message as projected from the event stream (the read model). */
export interface Message {
	id: string;
	username: string;
	/** Stored payload: ciphertext envelope (or legacy plaintext). */
	text: StoredText;
	/** Stream version of the MessagePosted event — stable ordering key. */
	seq: number;
	postedAt: string;
	editedAt: string | null;
	deleted: boolean;
}
