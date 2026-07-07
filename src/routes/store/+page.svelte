<script lang="ts">
	import type { StoreObject, StoreObjectBody } from '$lib/server/browser';
	import { ROOM_STREAM } from '$lib/types';
	import { decryptJsonText } from '$lib/decryptView';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let objects = $state<StoreObject[]>([...data.objects]);
	let selected = $state<StoreObjectBody | null>(null);
	let selectedKey = $state<string | null>(null);
	let pretty = $state(false);
	let decrypt = $state(false);
	let decryptedText = $state('');
	let loading = $state(false);
	let wiping = $state(false);
	let err = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const totalBytes = $derived(objects.reduce((n, o) => n + o.size, 0));

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(2)} MB`;
	}

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	const shown = $derived.by(() => {
		if (!selected) return '';
		if (decrypt) return decryptedText || 'Decrypting…';
		if (!pretty) return selected.text;
		try {
			return JSON.stringify(JSON.parse(selected.text), null, 2);
		} catch {
			return selected.text;
		}
	});

	// Decryption is async (it fetches keyrings), so it can't live in a $derived.
	// Recompute whenever the selected object or the decrypt toggle changes; a
	// token guards against an older object's decrypt landing after a newer
	// selection. The server never sees plaintext — this is model-B decryption
	// in the browser, so a crypto-shredded field shows here as erased too.
	$effect(() => {
		const sel = selected;
		if (!sel || !decrypt) return;
		const key = sel.key;
		decryptedText = '';
		decryptJsonText(sel.text, ROOM_STREAM).then((t) => {
			if (selected?.key === key && decrypt) decryptedText = t;
		});
	});

	async function select(key: string) {
		selectedKey = key;
		err = null;
		loading = true;
		try {
			const res = await fetch(`/api/store/object?key=${encodeURIComponent(key)}`);
			if (!res.ok) {
				err = (await res.json().catch(() => ({})))?.message ?? 'Failed to load object';
				selected = null;
				return;
			}
			selected = (await res.json()) as StoreObjectBody;
		} catch {
			err = 'Failed to load object';
			selected = null;
		} finally {
			loading = false;
		}
	}

	async function refresh() {
		err = null;
		try {
			const res = await fetch('/api/store');
			if (!res.ok) return;
			objects = ((await res.json()) as { objects: StoreObject[] }).objects;
			if (selectedKey && !objects.some((o) => o.key === selectedKey)) {
				selected = null;
				selectedKey = null;
			}
		} catch {
			/* ignore transient errors */
		}
	}

	async function wipe() {
		if (
			!confirm(
				'Delete every object in the R2 bucket and flush the cached feed pages? This resets the chat to empty and cannot be undone.'
			)
		)
			return;
		wiping = true;
		err = null;
		notice = null;
		try {
			const res = await fetch('/api/store', { method: 'DELETE' });
			if (!res.ok) {
				err = (await res.json().catch(() => ({})))?.message ?? 'Reset failed';
				return;
			}
			const { deleted, purged } = (await res.json()) as { deleted: number; purged: number };
			objects = [];
			selected = null;
			selectedKey = null;
			notice = `Deleted ${deleted} object${deleted === 1 ? '' : 's'} · flushed ${purged} cached page${purged === 1 ? '' : 's'}.`;
		} catch {
			err = 'Reset failed';
		} finally {
			wiping = false;
		}
	}
</script>

<div class="page">
	<header>
		<div class="title">
			<span class="logo">🗄️</span>
			<div>
				<h1>Storage</h1>
				<p class="sub">
					{objects.length} object{objects.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)} in the
					<code>EVENTS</code> R2 bucket — the raw files behind the chat
				</p>
			</div>
		</div>
		<div class="nav">
			<button class="ghost" onclick={refresh}>↻ Refresh</button>
			<button class="danger" onclick={wipe} disabled={wiping}>
				{wiping ? 'Resetting…' : '🗑 Delete bucket & flush caches'}
			</button>
			<a class="ghost" href="/api">🔌 API</a>
			<a class="ghost" href="/keys">🔑 Keys</a>
			<a class="ghost" href="/">← Back to chat</a>
		</div>
	</header>

	{#if notice}<div class="banner ok">{notice}</div>{/if}
	{#if err}<div class="banner">{err}</div>{/if}

	<div class="split">
		<aside class="list">
			{#if objects.length === 0}
				<p class="empty">
					The bucket is empty — post a message in the chat to append the first event.
				</p>
			{/if}
			{#each objects as o (o.key)}
				<button class="item" class:active={o.key === selectedKey} onclick={() => select(o.key)}>
					<span class="key">{o.key}</span>
					<span class="size">{fmtBytes(o.size)}</span>
				</button>
			{/each}
		</aside>

		<section class="viewer">
			{#if !selectedKey}
				<div class="hint">Select an object on the left to see its contents verbatim.</div>
			{:else if loading}
				<div class="hint">Loading…</div>
			{:else if selected}
				<div class="meta">
					<div class="metakey">{selected.key}</div>
					<div class="metarow">
						<span>{fmtBytes(selected.size)}</span>
						<span>etag {selected.etag}</span>
						<span>{fmtTime(selected.uploaded)}</span>
						<label class="toggle">
							<input type="checkbox" bind:checked={pretty} disabled={decrypt} />
							Pretty-print JSON
						</label>
						<label class="toggle">
							<input type="checkbox" bind:checked={decrypt} />
							Decrypt
						</label>
					</div>
				</div>
				<pre class="content">{shown}</pre>
			{/if}
		</section>
	</div>
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		height: 100dvh;
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
		flex-wrap: wrap;
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
	.nav {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.ghost,
	.danger {
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
	.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		color: var(--danger);
	}
	.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}
	.danger:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.banner {
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		padding: 0.55rem 1.1rem;
		font-size: 0.85rem;
		border-bottom: 1px solid var(--border);
	}
	.banner.ok {
		background: color-mix(in srgb, #16a34a 15%, transparent);
		color: #16a34a;
	}
	.split {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(240px, 360px) 1fr;
		min-height: 0;
	}
	.list {
		border-right: 1px solid var(--border);
		overflow-y: auto;
		padding: 0.5rem;
		background: var(--surface);
	}
	.item {
		width: 100%;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.45rem 0.55rem;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.item:hover {
		background: var(--surface-2);
	}
	.item.active {
		background: var(--accent-soft);
		outline: 1px solid var(--accent);
	}
	.key {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.72rem;
		overflow-wrap: anywhere;
		line-height: 1.35;
	}
	.size {
		font-size: 0.68rem;
		color: var(--muted);
	}
	.viewer {
		overflow: auto;
		padding: 1rem 1.1rem;
		min-width: 0;
	}
	.hint,
	.empty {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.empty {
		padding: 0.5rem;
	}
	.meta {
		margin-bottom: 0.6rem;
	}
	.metakey {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.metarow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.85rem;
		margin-top: 0.35rem;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		cursor: pointer;
		user-select: none;
	}
	.content {
		margin: 0;
		padding: 0.85rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 10px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.78rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	@media (max-width: 720px) {
		.split {
			grid-template-columns: 1fr;
		}
		.list {
			max-height: 40vh;
			border-right: none;
			border-bottom: 1px solid var(--border);
		}
	}
</style>
