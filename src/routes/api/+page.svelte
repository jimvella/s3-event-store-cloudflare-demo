<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const me = data.username ?? '';

	type FieldKind = 'query' | 'path' | 'body' | 'raw' | 'header';
	interface Field {
		name: string;
		label: string;
		kind: FieldKind;
		default?: string;
		placeholder?: string;
		multiline?: boolean;
	}
	interface Endpoint {
		id: string;
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
		path: string; // may contain {name} path params
		title: string;
		desc: string;
		fields: Field[];
		danger?: boolean;
	}
	interface Result {
		status: number;
		ok: boolean;
		ms: number;
		method: string;
		url: string;
		reqBody: string | null;
		curl: string;
		body: string;
		headers: [string, string][]; // notable response headers to display
		etag: string | null; // ETag response header, if any
		prev: string | null; // feed page link (from the JSON body)
		next: string | null;
		head: string | null; // head resource's link into the paging space
	}

	// Response headers worth surfacing to show the caching contract.
	const SHOWN_HEADERS = ['cache-control', 'etag', 'content-type', 'vary', 'age'];

	// The client-facing seam: every HTTP call the browser SPA makes to the Worker —
	// all of them the library's own primitives (append, feed, head).
	const ENDPOINTS: Endpoint[] = [
		{
			id: 'append',
			method: 'POST',
			path: '/streams/chat:general/events',
			title: 'Raw append — submit client-built events',
			desc: "Clients author the events (each with a stable `id` = idempotency key) and submit them with the `expectedVersion` from the head resource. idempotentAppend commits them (201) or, if a lost-response retry already did, reports alreadyCommitted (200). Fire it twice unchanged → the second is alreadyCommitted (same event id). Change expectedVersion to a stale number → 409 with the current headVersion.",
			fields: [
				{ name: '__raw', label: 'request body (JSON)', kind: 'raw', multiline: true, default: '' }
			]
		},
		{
			id: 'feed',
			method: 'GET',
			path: '/streams/chat:general/events',
			title: 'Read the log as a paginated feed',
			desc: "The library's HTTP egress wire format (readPage/toWireFeed): { from, to, complete, events, prev, next }. Complete pages are cacheable forever.",
			fields: [{ name: 'from', label: 'from (page cursor)', kind: 'query', default: '0' }]
		},
		{
			id: 'head',
			method: 'GET',
			path: '/streams/chat:general/head',
			title: 'Read the pollable head resource',
			desc: "The short-poll target (readHead/toWireHead): { version, head, etag }, served Cache-Control: public, max-age=1 so Cloudflare edge-caches it for a second — a burst of client polls is absorbed at the edge (no Worker, no R2). Appends purge it. Send the ETag back as If-None-Match for a 304 once the cache goes stale.",
			fields: [
				{
					name: 'If-None-Match',
					label: 'If-None-Match',
					kind: 'header',
					placeholder: 'paste an ETag (e.g. "v7") to test a 304'
				}
			]
		},
		{
			id: 'keyring',
			method: 'GET',
			path: '/keys/{subject}/keyring',
			title: 'Keyring delivery — the decryption keys (model B)',
			desc: "Every key generation a subject has, base64, served no-store (contrast with the immutable ciphertext feed pages). Addressed by the opaque subject that events carry — the only plaintext author identifier; the username itself is one of the encrypted fields these keys unlock. Once a shred is requested, this returns an EMPTY keyring — the instant, everywhere-at-once soft delete. Prefilled with YOUR subject.",
			fields: [{ name: 'subject', label: 'subject (hashed)', kind: 'path', default: data.mySubject }]
		},
		{
			id: 'rotate',
			method: 'POST',
			path: '/api/keys/rotate',
			title: 'Rotate your data key',
			desc: 'Mint the next key generation for your account. Old generations stay deliverable (existing messages keep decrypting); new messages encrypt under the new keyId — post one after rotating and compare the per-field keyId in the feed.',
			fields: []
		},
		{
			id: 'shred',
			method: 'POST',
			path: '/api/shred',
			title: 'Request crypto-shredding (GDPR erasure) of YOUR account',
			desc: "The library's requestShred: appends a ShredRequested intent to $system.key-audit, then writes the tombstone (pending). Instantly soft-deleted: your keyring goes empty, your messages render as erased, appends fail closed with 410. Nothing is destroyed until the sweeper runs after the waiting period — cancel before that and everything comes back.",
			fields: [],
			danger: true
		},
		{
			id: 'shred-cancel',
			method: 'POST',
			path: '/api/shred/cancel',
			title: 'Cancel a pending shred',
			desc: 'Audit-first cancellation of the intent stamped on your tombstone. Works while the tombstone is pending; once the sweeper has moved it to committing the point of no return has passed (lost-to-commit).',
			fields: []
		},
		{
			id: 'sweep',
			method: 'POST',
			path: '/api/shred/sweep',
			title: 'Run the shred sweeper',
			desc: 'The one clock-driven job (a cron in production, a button here). Scans $system.key-audit from its checkpoint and drives every open intent to completion: inside the waiting period → openSubjects, untouched; past it → keys hard-deleted + ShredCompleted appended. Idempotent — fire it as often as you like.',
			fields: []
		}
	];

	let inputs = $state<Record<string, Record<string, string>>>({});
	let results = $state<Record<string, Result | undefined>>({});
	let busy = $state<Record<string, boolean>>({});

	for (const ep of ENDPOINTS) {
		inputs[ep.id] = {};
		for (const f of ep.fields) inputs[ep.id][f.name] = f.default ?? '';
	}

	function prettyMaybe(s: string): string {
		try {
			return JSON.stringify(JSON.parse(s), null, 2);
		} catch {
			return s;
		}
	}

	function build(ep: Endpoint) {
		const inp = inputs[ep.id];
		let path = ep.path;
		const query = new URLSearchParams();
		const body: Record<string, string> = {};
		const headers: Record<string, string> = {};
		let hasBody = false;
		let rawBody: string | null = null;
		for (const f of ep.fields) {
			const v = inp[f.name] ?? '';
			if (f.kind === 'path') path = path.replace(`{${f.name}}`, encodeURIComponent(v));
			else if (f.kind === 'query') {
				if (v !== '') query.set(f.name, v);
			} else if (f.kind === 'header') {
				if (v !== '') headers[f.name] = v;
			} else if (f.kind === 'raw') {
				rawBody = v; // used verbatim as the request body
			} else {
				body[f.name] = v;
				hasBody = true;
			}
		}
		const qs = query.toString();
		const url = path + (qs ? `?${qs}` : '');
		const reqBody = rawBody !== null ? rawBody : hasBody ? JSON.stringify(body) : null;
		return { url, reqBody, headers };
	}

	function toCurl(ep: Endpoint, url: string, reqBody: string | null, headers: Record<string, string>): string {
		const origin = typeof location !== 'undefined' ? location.origin : '';
		let c = `curl -X ${ep.method} '${origin}${url}'`;
		for (const [k, v] of Object.entries(headers)) c += ` \\\n  -H '${k}: ${v}'`;
		if (reqBody) c += ` \\\n  -H 'content-type: application/json' \\\n  -d '${reqBody}'`;
		return c;
	}

	/** The `from` cursor a feed prev/next link points at, e.g. "5" from `…?from=5`. */
	function cursorOf(link: string | null): string | null {
		if (!link) return null;
		try {
			return new URL(link, location.origin).searchParams.get('from');
		} catch {
			return null;
		}
	}

	async function run(ep: Endpoint) {
		if (ep.danger && !confirm(`Really send ${ep.method} ${ep.path}?`)) return;
		const { url, reqBody, headers } = build(ep);
		busy[ep.id] = true;
		const started = performance.now();
		try {
			const res = await fetch(url, {
				method: ep.method,
				headers: { ...(reqBody ? { 'content-type': 'application/json' } : {}), ...headers },
				body: reqBody ?? undefined
			});
			const ms = Math.round(performance.now() - started);
			const text = await res.text();
			let json: unknown = null;
			let pretty = text;
			try {
				json = JSON.parse(text);
				pretty = JSON.stringify(json, null, 2);
			} catch {
				/* not JSON (e.g. a 304 has no body) — show raw */
			}
			const shown: [string, string][] = SHOWN_HEADERS.map(
				(h) => [h, res.headers.get(h)] as [string, string | null]
			)
				.filter((e): e is [string, string] => e[1] !== null)
				.map(([k, v]) => [k, v]);
			const j = json as { prev?: string | null; next?: string | null; head?: string | null } | null;
			results[ep.id] = {
				status: res.status,
				ok: res.ok,
				ms,
				method: ep.method,
				url,
				reqBody: reqBody ? prettyMaybe(reqBody) : null,
				curl: toCurl(ep, url, reqBody, headers),
				body: pretty,
				headers: shown,
				etag: res.headers.get('etag'),
				prev: j?.prev ?? null,
				next: j?.next ?? null,
				head: j?.head ?? null
			};
		} catch (e) {
			results[ep.id] = {
				status: 0,
				ok: false,
				ms: Math.round(performance.now() - started),
				method: ep.method,
				url,
				reqBody,
				curl: toCurl(ep, url, reqBody, headers),
				body: String(e),
				headers: [],
				etag: null,
				prev: null,
				next: null,
				head: null
			};
		} finally {
			busy[ep.id] = false;
		}
	}

	/** Replay a request with `If-None-Match` set to the ETag we just got — the 304 poll. */
	function resendConditional(ep: Endpoint, etag: string) {
		inputs[ep.id]['If-None-Match'] = etag;
		run(ep);
	}

	/** Follow a feed prev/next link by setting the `from` cursor and re-fetching. */
	function goToPage(ep: Endpoint, link: string | null) {
		const from = cursorOf(link);
		if (from === null) return;
		inputs[ep.id].from = from;
		run(ep);
	}

	const feedEndpoint = ENDPOINTS.find((e) => e.id === 'feed')!;

	/** Follow the head resource's `head` link into the paging space: drive the
	 * feed endpoint to that page and scroll its card into view. */
	function fetchHeadPage(link: string | null) {
		goToPage(feedEndpoint, link);
		if (typeof document !== 'undefined') {
			document.getElementById('card-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	// Prefill the raw-append body with a valid, ready-to-fire template: the
	// current head version as expectedVersion, the session username, and freshly
	// minted event/message ids (the ids are the idempotency keys).
	onMount(async () => {
		let expectedVersion: number | 'noStream' = 'noStream';
		try {
			const res = await fetch(`/streams/${encodeURIComponent('chat:general')}/head`);
			if (res.ok) {
				const head = (await res.json()) as { version: number | null };
				expectedVersion = typeof head.version === 'number' && head.version >= 0 ? head.version : 'noStream';
			}
		} catch {
			/* ignore — leave "noStream" */
		}
		const template = JSON.stringify(
			{
				expectedVersion,
				events: [
					{
						id: crypto.randomUUID(),
						type: 'MessagePosted',
						data: {
							messageId: crypto.randomUUID(),
							username: me,
							text: 'raw append from the API browser 👋'
						}
					}
				]
			},
			null,
			2
		);
		if (inputs.append && inputs.append.__raw === '') inputs.append.__raw = template;
	});
</script>

<div class="page">
	<header>
		<div class="title">
			<span class="logo">🔌</span>
			<div>
				<h1>API browser</h1>
				<p class="sub">
					The client–server <strong>seam</strong> — every HTTP call the browser makes to the Worker.
					Fire real requests against your session and watch what crosses the wire.
				</p>
			</div>
		</div>
		<div class="nav">
			<a class="ghost" href="/store">🗄️ Storage</a>
			<a class="ghost" href="/keys">🔑 Keys</a>
			<a class="ghost" href="/">← Back to chat</a>
		</div>
	</header>

	<div class="body">
		<p class="note">
			These are same-origin, cookie-authenticated JSON endpoints. Auth itself
			(<code>POST /login</code>, <code>POST /logout</code>) is a CSRF-protected HTML form, not part
			of this JSON seam.
		</p>

		{#each ENDPOINTS as ep (ep.id)}
			{@const preview = build(ep)}
			<section class="card" class:danger={ep.danger} id="card-{ep.id}">
				<div class="head">
					<span class="method m-{ep.method}">{ep.method}</span>
					<code class="path">{ep.path}</code>
					<span class="cardtitle">{ep.title}</span>
					<button class="send" disabled={busy[ep.id]} onclick={() => run(ep)}>
						{busy[ep.id] ? 'Sending…' : 'Send'}
					</button>
				</div>
				<p class="desc">{ep.desc}</p>

				{#if ep.fields.length}
					<div class="fields">
						{#each ep.fields as f (f.name)}
							<label class:wide={f.multiline}>
								<span class="flabel">{f.label} <em>({f.kind})</em></span>
								{#if f.multiline}
									<textarea class="rawbody" rows="10" bind:value={inputs[ep.id][f.name]}></textarea>
								{:else}
									<input bind:value={inputs[ep.id][f.name]} placeholder={f.placeholder ?? ''} />
								{/if}
							</label>
						{/each}
					</div>
				{/if}

				<div class="reqline">
					<span class="m-{ep.method} method sm">{ep.method}</span>
					<code>{preview.url}</code>
				</div>

				{#if results[ep.id]}
					{@const r = results[ep.id]!}
					<div class="result">
						<details open>
							<summary>Request</summary>
							<pre class="mono req">{r.curl}</pre>
						</details>
						<div class="respmeta">
							<span
								class="status"
								class:ok={r.ok}
								class:bad={!r.ok}
								class:notmod={r.status === 304}
							>
								{r.status || 'ERR'}{r.status === 304 ? ' Not Modified' : r.ok ? ' OK' : ''}
							</span>
							<span class="ms">{r.ms} ms</span>
							{#if r.etag}<span class="etagchip">ETag {r.etag}</span>{/if}
						</div>

						{#if r.headers.length}
							<div class="rheaders">
								{#each r.headers as [k, v] (k)}
									<span class="hdr" class:cache={k === 'cache-control' || k === 'etag'}>
										<b>{k}:</b> {v}
									</span>
								{/each}
							</div>
						{/if}

						{#if r.body}<pre class="mono resp">{r.body}</pre>{/if}

						{#if ep.id === 'head' && r.etag}
							<div class="actions">
								<button class="pill" onclick={() => resendConditional(ep, r.etag!)}>
									↩ Resend with If-None-Match: {r.etag} → expect 304
								</button>
								{#if r.head}
									<button class="pill" onclick={() => fetchHeadPage(r.head)}>
										⤓ Fetch head page (from {cursorOf(r.head)}) →
									</button>
								{/if}
							</div>
						{/if}

						{#if ep.id === 'feed'}
							{@const prevFrom = cursorOf(r.prev)}
							{@const nextFrom = cursorOf(r.next)}
							<div class="actions pager">
								<button class="pill" disabled={!r.prev} onclick={() => goToPage(ep, r.prev)}>
									← prev{prevFrom !== null ? ` (from ${prevFrom})` : ''}
								</button>
								<span class="cursors">follow the page links to walk the log</span>
								<button class="pill" disabled={!r.next} onclick={() => goToPage(ep, r.next)}>
									next{nextFrom !== null ? ` (from ${nextFrom})` : ''} →
								</button>
							</div>
						{/if}
					</div>
				{/if}
			</section>
		{/each}
	</div>
</div>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1.1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		position: sticky;
		top: 0;
		z-index: 1;
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
		max-width: 46ch;
	}
	.nav {
		display: flex;
		gap: 0.5rem;
		white-space: nowrap;
	}
	.ghost {
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}
	.ghost:hover {
		background: var(--surface-2);
	}
	.body {
		padding: 1rem 1.1rem 3rem;
	}
	.note {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 0 0 1rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		padding: 0.85rem 1rem;
		margin-bottom: 0.9rem;
	}
	.card.danger {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.method {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.72rem;
		font-weight: 700;
		padding: 0.15rem 0.45rem;
		border-radius: 6px;
		color: #fff;
	}
	.method.sm {
		font-size: 0.66rem;
	}
	.m-GET {
		background: #2563eb;
	}
	.m-POST {
		background: #16a34a;
	}
	.m-PATCH {
		background: #d97706;
	}
	.m-DELETE {
		background: #dc2626;
	}
	.path {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.82rem;
		font-weight: 600;
	}
	.cardtitle {
		font-size: 0.82rem;
		color: var(--muted);
	}
	.send {
		margin-left: auto;
		padding: 0.35rem 0.9rem;
		border-radius: 8px;
		border: none;
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.send:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.desc {
		margin: 0.45rem 0 0.6rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.6rem;
		margin-bottom: 0.65rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.flabel {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.flabel em {
		opacity: 0.7;
	}
	input,
	.rawbody {
		padding: 0.4rem 0.55rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--input-bg);
		color: var(--text);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.78rem;
	}
	label.wide {
		grid-column: 1 / -1;
	}
	.rawbody {
		width: 100%;
		resize: vertical;
		line-height: 1.5;
	}
	.reqline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.55rem;
		background: var(--surface-2);
		border-radius: 8px;
		overflow-x: auto;
	}
	.reqline code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.76rem;
		white-space: nowrap;
	}
	.result {
		margin-top: 0.7rem;
	}
	details summary {
		cursor: pointer;
		font-size: 0.75rem;
		color: var(--muted);
		margin-bottom: 0.3rem;
	}
	.respmeta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.5rem 0 0.3rem;
	}
	.status {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.74rem;
		font-weight: 700;
		padding: 0.15rem 0.5rem;
		border-radius: 6px;
	}
	.status.ok {
		background: color-mix(in srgb, #16a34a 22%, transparent);
		color: #16a34a;
	}
	.status.bad {
		background: color-mix(in srgb, var(--danger) 20%, transparent);
		color: var(--danger);
	}
	.status.notmod {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		color: var(--accent);
	}
	.ms {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.etagchip {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.72rem;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.1rem 0.4rem;
	}
	.rheaders {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.7rem;
		margin: 0 0 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.71rem;
		color: var(--muted);
	}
	.hdr b {
		color: var(--text);
		font-weight: 600;
	}
	.hdr.cache {
		color: var(--text);
	}
	.hdr.cache b {
		color: var(--accent);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.5rem;
		flex-wrap: wrap;
	}
	.pager {
		justify-content: space-between;
	}
	.cursors {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.pill {
		font-size: 0.74rem;
		padding: 0.3rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.pill:hover:not(:disabled) {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.pill:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.mono {
		margin: 0;
		padding: 0.6rem 0.7rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.req {
		margin-bottom: 0.2rem;
	}

	@media (max-width: 640px) {
		header {
			flex-direction: column;
			align-items: stretch;
			gap: 0.55rem;
			position: static;
		}
		.sub {
			max-width: none;
		}
		.nav {
			justify-content: flex-start;
		}
		.fields {
			grid-template-columns: 1fr;
		}
		.head {
			gap: 0.4rem;
		}
		.send {
			margin-left: 0;
		}
	}
</style>
