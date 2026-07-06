// Shared types between server and client.

/** Event types appended to the chat stream. */
export type ChatEventType = 'MessagePosted' | 'MessageEdited' | 'MessageDeleted';

export interface MessagePostedData {
	messageId: string;
	username: string;
	text: string;
}

export interface MessageEditedData {
	messageId: string;
	text: string;
}

export interface MessageDeletedData {
	messageId: string;
}

/** A message as projected from the event stream (the read model). */
export interface Message {
	id: string;
	username: string;
	text: string;
	/** Stream version of the MessagePosted event — stable ordering key. */
	seq: number;
	postedAt: string;
	editedAt: string | null;
	deleted: boolean;
}
