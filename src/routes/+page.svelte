<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { EventEnvelope, WireFeedPage, WireHead } from '@jimvella/s3-event-store';
	import {
		base64ToBytes,
		decryptField,
		importAesKey,
		isEncryptedField,
		type EncryptedField,
		type WireKeyring
	} from '$lib/crypto';
	import type { Message, StoredText } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const me = data.username ?? '';
	const STREAM = 'chat:general';
	const EVENTS_URL = `/streams/${encodeURIComponent(STREAM)}/events`;
	const HEAD_URL = `/streams/${encodeURIComponent(STREAM)}/head`;

	type ClientEvent = { id: string; type: string; data: Record<string, unknown> };

	/**
	 * A message as the client renders it. The feed only ever carries ciphertext
	 * (model B — the server never decrypts), so alongside the projection fields
	 * we track the current ciphertext envelope, the locally decrypted plaintext,
	 * and whether decryption failed closed (author crypto-shredded).
	 */
	type ViewMessage = Omit<Message, 'text'> & {
		/** Ciphertext envelope of the current text; null for legacy plaintext. */
		cipher: EncryptedField | null;
		/** Locally decrypted text ('' while decryption is pending). */
		plain: string;
		/** Fail-closed marker: no key can be delivered for this ciphertext. */
		erased: boolean;
	};

	function toView(m: Omit<Message, 'text'>, text: StoredText): ViewMessage {
		const enc = isEncryptedField(text);
		return {
			...m,
			cipher: enc ? text : null,
			plain: enc ? '' : (text as string),
			erased: false
		};
	}

	// Client-side read model: the array is the source of truth, kept sorted by seq.
	let messages = $state<ViewMessage[]>(data.messages.map((m) => toView(m, m.text)));
	let cursor = $state<number>(data.cursor);

	// -------------------------------------------------------------------------
	// Local decryption (model B)
	// -------------------------------------------------------------------------
	//
	// Keyrings are fetched per author from `/keys/{username}/keyring` and the
	// keys imported into non-extractable WebCrypto handles, cached by keyId.
	// A keyId the cached keyring doesn't know triggers ONE fresh fetch (deduped
	// across concurrent misses); if the key still isn't deliverable, the
	// message renders as erased — decryption fails closed, never shows stale
	// plaintext. A periodic refresh re-fetches keyrings so a shred (or a
	// cancellation) done elsewhere converges in every open tab.

	const keyCache = new Map<string, Map<string, CryptoKey>>();
	const keyringFetches = new Map<string, Promise<Map<string, CryptoKey>>>();

	function loadKeyring(username: string): Promise<Map<string, CryptoKey>> {
		let p = keyringFetches.get(username);
		if (!p) {
			p = (async () => {
				const keys = new Map<string, CryptoKey>();
				try {
					const res = await fetch(`/keys/${encodeURIComponent(username)}/keyring`, {
						cache: 'no-store'
					});
					if (res.ok) {
						const { keyring } = (await res.json()) as WireKeyring;
						for (const e of keyring) keys.set(e.keyId, await importAesKey(base64ToBytes(e.key)));
					}
				} catch {
					/* transient — treated as an empty keyring; the refresh loop retries */
				}
				keyCache.set(username, keys);
				return keys;
			})().finally(() => keyringFetches.delete(username));
			keyringFetches.set(username, p);
		}
		return p;
	}

	/** Decrypt a message's current ciphertext in place, failing closed. */
	async function decryptMessage(m: ViewMessage) {
		const cipher = m.cipher;
		if (!cipher || m.deleted) return;
		let keys = keyCache.get(m.username) ?? (await loadKeyring(m.username));
		let key = keys.get(cipher.keyId);
		if (!key) {
			keys = await loadKeyring(m.username); // one fresh look before giving up
			key = keys.get(cipher.keyId);
		}
		if (m.cipher !== cipher || m.deleted) return; // edited/deleted while we fetched
		if (!key) {
			m.erased = true;
			m.plain = '';
			return;
		}
		try {
			m.plain = await decryptField(key, STREAM, 'text', cipher);
			m.erased = false;
		} catch {
			m.erased = true; // wrong key or tampered ciphertext — never show garbage
			m.plain = '';
		}
	}

	/** Drop cached keyrings and re-decrypt everything — how a shred done in
	 * another tab (or its cancellation) becomes visible here. */
	async function refreshKeys() {
		keyCache.clear();
		await Promise.all(messages.map(decryptMessage));
	}

	let draft = $state('');
	let editingId = $state<string | null>(null);
	let editText = $state('');
	let banner = $state<string | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | undefined;

	let listEl: HTMLDivElement | undefined;
	let polling = false;

	const POLL_MS = 1500; // > the head's 1s edge TTL, so each poll gets a fresh edge copy
	const KEY_REFRESH_MS = 15_000; // keyring re-fetch: how fast a remote shred/cancel shows up here

	function flash(msg: string) {
		banner = msg;
		clearTimeout(bannerTimer);
		bannerTimer = setTimeout(() => (banner = null), 4000);
	}

	/** Fold one stored event envelope into the local read model. The `text` in
	 * the envelope is whatever was stored — normally a ciphertext field — so a
	 * fold schedules local decryption rather than trusting it to be readable. */
	function applyEvent(e: EventEnvelope) {
		const ts = e.meta?.ts ?? '';
		if (e.type === 'MessagePosted') {
			const d = e.data as { messageId: string; username: string; text: StoredText };
			if (!messages.some((m) => m.id === d.messageId)) {
				const m = toView(
					{
						id: d.messageId,
						username: d.username,
						seq: e.version,
						postedAt: ts,
						editedAt: null,
						deleted: false
					},
					d.text
				);
				messages.push(m);
				void decryptMessage(messages[messages.length - 1]);
			}
		} else if (e.type === 'MessageEdited') {
			const d = e.data as { messageId: string; text: StoredText };
			const m = messages.find((x) => x.id === d.messageId);
			if (m && !m.deleted) {
				if (isEncryptedField(d.text)) {
					m.cipher = d.text;
					m.plain = '';
				} else {
					m.cipher = null;
					m.plain = d.text;
				}
				m.erased = false;
				m.editedAt = ts;
				void decryptMessage(m);
			}
		} else if (e.type === 'MessageDeleted') {
			const d = e.data as { messageId: string };
			const m = messages.find((x) => x.id === d.messageId);
			if (m) {
				m.deleted = true;
				m.cipher = null;
				m.plain = '';
				m.erased = false;
			}
		}
	}

	/** Walk feed pages from our cursor up to `target`, folding the envelopes. */
	async function foldFrom(target: number) {
		const wasAtBottom = atBottom();
		let url: string | null = `${EVENTS_URL}?from=${cursor}`;
		while (url) {
			// Bypass the *browser* HTTP cache: complete pages are `immutable`, but
			// the demo's reset button reuses version numbers, so a cached page can
			// go stale. The server-side edge cache (caches.default) still serves the
			// immutable pages fast; we just don't let the browser pin them.
			const pres: Response = await fetch(url, { cache: 'no-store' });
			if (!pres.ok) break;
			const page = (await pres.json()) as WireFeedPage;
			for (const e of page.events) applyEvent(e);
			url = page.next && page.to <= target ? page.next : null;
		}
		messages.sort((a, b) => a.seq - b.seq);
		cursor = target + 1;
		if (wasAtBottom) {
			await tick();
			scrollToBottom();
		}
	}

	/**
	 * Short poll: read the head (letting the browser/edge micro-cache serve it —
	 * that's what keeps origin load flat), and if it moved past our cursor, walk
	 * the feed to fold the new events. The `polling` guard skips a tick if the
	 * previous one is still folding. Our own messages are folded immediately from
	 * the append response (see `send`), so this only carries *other* people's.
	 */
	async function shortPoll() {
		if (polling) return;
		polling = true;
		try {
			const res = await fetch(HEAD_URL); // default cache mode → hits the 1s edge cache
			if (!res.ok) return;
			const head = (await res.json()) as WireHead;
			if (head.version !== null && head.version >= cursor) await foldFrom(head.version);
		} catch {
			// transient — the next tick retries
		} finally {
			polling = false;
		}
	}

	async function readBody(res: Response): Promise<string> {
		try {
			const j = await res.json();
			return j?.message ?? 'Request failed';
		} catch {
			return 'Request failed';
		}
	}

	/**
	 * Submit client-built events to the raw-append endpoint. The event `id`s are
	 * the idempotency keys — minted once by the caller and reused across every
	 * retry here. We start from our polled `cursor` as the expected head version;
	 * on a 409 (a concurrent writer beat us) we take the head the server reports
	 * and retry the *same* events. A dropped response is retried the same way and
	 * comes back `alreadyCommitted`, so nothing double-posts.
	 *
	 * This is purely the write: it never touches `cursor`. On success it returns
	 * the stream's new head version (from the append response) so the caller can
	 * fold its own events straight from the feed — no head read, so own messages
	 * appear instantly and never hit the micro-cache's ≤1s staleness.
	 */
	async function submit(events: ClientEvent[]): Promise<number | null> {
		let expectedVersion: number | 'noStream' = cursor <= 0 ? 'noStream' : cursor - 1;
		for (let attempt = 0; attempt < 6; attempt++) {
			let res: Response;
			try {
				res = await fetch(EVENTS_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ events, expectedVersion })
				});
			} catch {
				continue; // network hiccup — retry with the same ids (idempotent)
			}
			if (res.status === 409) {
				const { headVersion } = (await res.json().catch(() => ({ headVersion: -1 }))) as {
					headVersion: number;
				};
				expectedVersion = headVersion < 0 ? 'noStream' : headVersion;
				continue;
			}
			if (!res.ok) {
				flash(await readBody(res));
				return null;
			}
			const { nextExpectedVersion } = (await res.json()) as { nextExpectedVersion: number };
			return nextExpectedVersion;
		}
		flash('Could not append after several retries — heavy contention, try again.');
		return null;
	}

	async function send() {
		const text = draft.trim();
		if (!text) return;
		draft = '';
		const event: ClientEvent = {
			id: crypto.randomUUID(),
			type: 'MessagePosted',
			data: { messageId: crypto.randomUUID(), username: me, text }
		};
		const version = await submit([event]);
		if (version === null) {
			draft = text; // restore so the user doesn't lose it
			return;
		}
		await foldFrom(version); // fold our own message immediately, no head read
		scrollToBottom();
	}

	function startEdit(m: ViewMessage) {
		editingId = m.id;
		editText = m.plain;
	}

	function cancelEdit() {
		editingId = null;
		editText = '';
	}

	async function saveEdit(m: ViewMessage) {
		const text = editText.trim();
		if (!text || text === m.plain) {
			cancelEdit();
			return;
		}
		const event: ClientEvent = {
			id: crypto.randomUUID(),
			type: 'MessageEdited',
			data: { messageId: m.id, text }
		};
		const version = await submit([event]);
		if (version !== null) {
			cancelEdit();
			await foldFrom(version);
		}
	}

	async function remove(m: ViewMessage) {
		if (!confirm('Delete this message? Its history stays in the event log.')) return;
		const event: ClientEvent = {
			id: crypto.randomUUID(),
			type: 'MessageDeleted',
			data: { messageId: m.id }
		};
		const version = await submit([event]);
		if (version !== null) await foldFrom(version);
	}

	function atBottom(): boolean {
		if (!listEl) return true;
		return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
	}

	function scrollToBottom() {
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	}

	function fmtTime(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	onMount(() => {
		scrollToBottom();

		// The SSR payload carries ciphertext (the server can't and doesn't
		// decrypt) — resolve it locally now that WebCrypto is available.
		void Promise.all(messages.map(decryptMessage));

		// Only poll while the tab is actually in view. A hidden tab makes zero
		// requests (browsers throttle background timers anyway; this stops them
		// outright), and on return we sync immediately so the user sees the latest
		// without waiting for the next tick. Cheap client/battery win — the edge
		// micro-cache already keeps idle polling nearly free on the origin.
		let timer: ReturnType<typeof setInterval> | undefined;
		let keyTimer: ReturnType<typeof setInterval> | undefined;
		const start = () => {
			if (timer === undefined) timer = setInterval(shortPoll, POLL_MS);
			if (keyTimer === undefined) keyTimer = setInterval(refreshKeys, KEY_REFRESH_MS);
		};
		const stop = () => {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			if (keyTimer !== undefined) {
				clearInterval(keyTimer);
				keyTimer = undefined;
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') {
				shortPoll(); // catch up instantly on return
				refreshKeys();
				start();
			} else {
				stop();
			}
		};

		document.addEventListener('visibilitychange', onVisibility);
		if (document.visibilityState === 'visible') start();

		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<div class="app">
	<header>
		<div class="title">
			<span class="logo">💬</span>
			<div>
				<h1>#general</h1>
				<p class="sub">
					{cursor} event{cursor === 1 ? '' : 's'} in the stream · backed by
					<code>@jimvella/s3-event-store</code> on R2
				</p>
			</div>
		</div>
		<div class="who">
			<span class="me">signed in as <strong>{me}</strong></span>
			<a
				class="ghost"
				href="https://github.com/jimvella/s3-event-store-cloudflare-demo"
				target="_blank"
				rel="noopener noreferrer">⧉ Source</a
			>
			<a class="ghost" href="/store">🗄️ Storage</a>
			<a class="ghost" href="/api">🔌 API</a>
			<a class="ghost" href="/keys">🔑 Keys</a>
			<form method="POST" action="/logout">
				<button class="ghost" type="submit">Log out</button>
			</form>
		</div>
	</header>

	{#if banner}
		<div class="banner" role="alert">{banner}</div>
	{/if}

	<div class="messages" bind:this={listEl}>
		{#if messages.length === 0}
			<div class="empty">No messages yet — say something to append the first event.</div>
		{/if}
		{#each messages as m (m.id)}
			{@const mine = m.username === me}
			<div class="row" class:mine>
				<div class="bubble" class:mine class:deleted={m.deleted}>
					{#if !mine}<div class="author">{m.username}</div>{/if}

					{#if m.deleted}
						<div class="tombstone">🚫 This message was deleted</div>
					{:else if m.erased}
						<div class="tombstone">
							🔒 Erased — the author's encryption key has been destroyed
						</div>
					{:else if editingId === m.id}
						<div class="editor">
							<textarea
								bind:value={editText}
								rows="2"
								onkeydown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault();
										saveEdit(m);
									}
									if (e.key === 'Escape') cancelEdit();
								}}
							></textarea>
							<div class="editor-actions">
								<button class="mini" onclick={() => saveEdit(m)}>Save</button>
								<button class="mini ghost" onclick={cancelEdit}>Cancel</button>
							</div>
						</div>
					{:else}
						<div class="text">{m.plain}</div>
					{/if}

					<div class="meta">
						<span class="time">{fmtTime(m.editedAt ?? m.postedAt)}</span>
						{#if m.editedAt && !m.deleted}<span class="edited">(edited)</span>{/if}
						{#if mine && !m.deleted && !m.erased && editingId !== m.id}
							<span class="actions">
								<button class="link" onclick={() => startEdit(m)}>edit</button>
								<button class="link danger" onclick={() => remove(m)}>delete</button>
							</span>
						{/if}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<div class="composer">
		<textarea
			bind:value={draft}
			onkeydown={onKeydown}
			rows="1"
			placeholder="Message #general…"
		></textarea>
		<button class="send" onclick={send} disabled={!draft.trim()}>Send</button>
	</div>
</div>

<style>
	.app {
		max-width: 820px;
		margin: 0 auto;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1.1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.title {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		min-width: 0;
	}
	.logo {
		font-size: 1.6rem;
	}
	h1 {
		margin: 0;
		font-size: 1.1rem;
	}
	.sub {
		margin: 0.1rem 0 0;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.sub code {
		font-size: 0.72rem;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		white-space: nowrap;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.me {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.who form {
		margin: 0;
	}
	.banner {
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		padding: 0.55rem 1.1rem;
		font-size: 0.85rem;
		border-bottom: 1px solid var(--border);
	}
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.empty {
		margin: auto;
		color: var(--muted);
		font-size: 0.9rem;
		text-align: center;
	}
	.row {
		display: flex;
		justify-content: flex-start;
	}
	.row.mine {
		justify-content: flex-end;
	}
	.bubble {
		max-width: 76%;
		padding: 0.5rem 0.75rem;
		border-radius: 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-bottom-left-radius: 4px;
	}
	.bubble.mine {
		background: var(--own);
		color: var(--own-text);
		border-color: transparent;
		border-radius: 14px;
		border-bottom-right-radius: 4px;
	}
	.bubble.deleted {
		background: var(--surface-2);
		border-style: dashed;
	}
	.author {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--accent);
		margin-bottom: 0.15rem;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.4;
	}
	.tombstone {
		font-style: italic;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: 0.68rem;
		opacity: 0.85;
	}
	.bubble.mine .meta {
		justify-content: flex-end;
	}
	.edited {
		font-style: italic;
	}
	.actions {
		display: inline-flex;
		gap: 0.4rem;
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.68rem;
		cursor: pointer;
		color: inherit;
		text-decoration: underline;
		opacity: 0.85;
	}
	.link.danger {
		color: #fecaca;
	}
	.bubble:not(.mine) .link.danger {
		color: var(--danger);
	}
	.editor textarea {
		width: 100%;
		resize: vertical;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--input-bg);
		color: var(--text);
		padding: 0.4rem;
		font: inherit;
	}
	.editor-actions {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.35rem;
	}
	.mini {
		font-size: 0.72rem;
		padding: 0.25rem 0.6rem;
		border-radius: 7px;
		border: none;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}
	.mini.ghost,
	.ghost {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
	}
	.ghost {
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}
	.composer {
		display: flex;
		gap: 0.6rem;
		padding: 0.8rem 1.1rem;
		border-top: 1px solid var(--border);
		background: var(--surface);
	}
	.composer textarea {
		flex: 1;
		resize: none;
		max-height: 8rem;
		padding: 0.6rem 0.8rem;
		border-radius: 12px;
		border: 1px solid var(--border);
		background: var(--input-bg);
		color: var(--text);
		font: inherit;
		line-height: 1.4;
	}
	.composer textarea:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.send {
		align-self: flex-end;
		padding: 0.6rem 1.1rem;
		border-radius: 12px;
		border: none;
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		cursor: pointer;
	}
	.send:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 640px) {
		header {
			flex-direction: column;
			align-items: stretch;
			gap: 0.55rem;
			padding: 0.7rem 0.9rem;
		}
		.who {
			justify-content: flex-start;
		}
		.me {
			flex-basis: 100%;
		}
		.bubble {
			max-width: 88%;
		}
		.composer {
			padding: 0.7rem 0.9rem;
		}
	}
</style>
