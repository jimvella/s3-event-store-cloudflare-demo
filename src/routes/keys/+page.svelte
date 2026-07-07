<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { SweepReport, Tombstone } from '@jimvella/s3-event-store';
	import { decryptFor } from '$lib/keyringClient';
	import { ROOM_STREAM } from '$lib/types';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busy = $state<Record<string, boolean>>({});
	let err = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let sweepReport = $state<SweepReport | null>(null);

	// Live clock for the waiting-period countdowns (seeded from the server so a
	// skewed client clock can't show nonsense).
	let now = $state(data.now);
	onMount(() => {
		const skew = data.now - Date.now();
		const t = setInterval(() => (now = Date.now() + skew), 1000);
		return () => clearInterval(t);
	});

	const mine = $derived(data.subjects.find((s) => s.subject === data.mySubject));

	// The page data is pseudonymous (subjects + ciphertext names, like any raw
	// consumer of the log); names resolve in the BROWSER through keyring
	// delivery. A shredded subject's name is unrecoverable — it renders as an
	// erased user, which is the anonymisation working as intended.
	let names = $state<Record<string, string | null>>({});
	$effect(() => {
		const subjects = data.subjects;
		void (async () => {
			const next: Record<string, string | null> = {};
			await Promise.all(
				subjects.map(async (s) => {
					next[s.subject] =
						s.name ??
						(s.nameCipher ? await decryptFor(s.subject, ROOM_STREAM, 'username', s.nameCipher) : null);
				})
			);
			names = next;
		})();
	});

	function nameOf(subjectId: string): string {
		const n = names[subjectId];
		if (n === undefined) return `${subjectId.slice(0, 12)}…`; // still resolving
		return n ?? '🔒 erased user';
	}

	function remainingMs(t: Tombstone): number {
		return Math.max(0, t.requestedAt + data.waitingPeriodMs - now);
	}

	function fmtRemaining(ms: number): string {
		const s = Math.ceil(ms / 1000);
		return s >= 120 ? `${Math.ceil(s / 60)} min` : `${s}s`;
	}

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	async function call(id: string, url: string, confirmMsg?: string) {
		if (confirmMsg && !confirm(confirmMsg)) return;
		busy[id] = true;
		err = null;
		notice = null;
		try {
			const res = await fetch(url, { method: 'POST' });
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			if (!res.ok) {
				err = typeof body.message === 'string' ? body.message : `Request failed (${res.status})`;
				return;
			}
			if (id === 'sweep') {
				sweepReport = body as unknown as SweepReport;
				notice = 'Sweeper run complete.';
			} else if (id === 'rotate') {
				notice = `Rotated: new key generation ${body.keyId} minted.`;
			} else if (id === 'shred') {
				notice = 'Shred requested — your keys are undeliverable as of now (soft delete).';
			} else if (id === 'cancel') {
				notice = `Cancellation: ${body.outcome}.`;
			}
			await invalidateAll();
		} catch (e) {
			err = String(e);
		} finally {
			busy[id] = false;
		}
	}
</script>

<div class="page">
	<header>
		<div class="title">
			<span class="logo">🔑</span>
			<div>
				<h1>Keys & crypto-shredding</h1>
				<p class="sub">
					Per-user data keys under <code>keystore/</code> in the same bucket — wrapped by a master
					key, addressed by a stable random <em>userId</em>, destroyed by the shred workflow.
				</p>
			</div>
		</div>
		<div class="nav">
			<button class="ghost" onclick={() => invalidateAll()}>↻ Refresh</button>
			<a class="ghost" href="/store">🗄️ Storage</a>
			<a class="ghost" href="/api">🔌 API</a>
			<a class="ghost" href="/">← Back to chat</a>
		</div>
	</header>

	{#if notice}<div class="banner ok">{notice}</div>{/if}
	{#if err}<div class="banner">{err}</div>{/if}

	<div class="body">
		<p class="note">
			Every message's <code>text</code> <em>and</em> <code>username</code> are AES-256-GCM
			ciphertext under the author's current key; the only plaintext author identifier is the
			opaque <code>subject</code> (so a raw fold of the log is pseudonymous by default — free
			anonymisation for analytics and test fixtures). The feed and the edge cache only ever hold
			ciphertext — the browser decrypts with keys fetched from
			<code>/keys/&lbrace;subject&rbrace;/keyring</code>. <strong>Deleting a message hides it;
			shredding a user's key erases their words <em>and their name</em> everywhere at once</strong>
			— including from immutable pages already cached at the edge and from every backup of the
			bucket.
		</p>

		{#if mine}
			<section class="card">
				<div class="cardhead">
					<h2>Your account — <strong>{data.me}</strong></h2>
					<div class="btns">
						<button
							class="pill"
							disabled={busy.rotate}
							onclick={() => call('rotate', '/api/keys/rotate')}
						>
							♻ Rotate key
						</button>
						{#if mine.tombstone && (mine.tombstone.state === 'pending' || mine.tombstone.state === 'committing')}
							<button
								class="pill"
								disabled={busy.cancel || mine.tombstone.state === 'committing'}
								onclick={() => call('cancel', '/api/shred/cancel')}
							>
								↩ Cancel shred
							</button>
						{:else}
							<button
								class="pill danger"
								disabled={busy.shred}
								onclick={() =>
									call(
										'shred',
										'/api/shred',
										'Request crypto-shredding of YOUR account? Your messages become unreadable immediately; after the waiting period the sweeper destroys your keys permanently and this username is burned forever (until the bucket is reset).'
									)}
							>
								🔥 Request shred (erase me)
							</button>
						{/if}
					</div>
				</div>
				<div class="kv">
					<span>subject</span><code>{mine.subject}</code>
					<span>key generations</span>
					<span>
						{mine.generations.length === 0
							? 'none yet — minted on your first message'
							: mine.generations.map((g) => g.keyId).join(', ')}
					</span>
				</div>
			</section>
		{/if}

		<section class="card">
			<h2>Subjects</h2>
			<p class="cardnote">
				A <em>subject</em> is the erasure unit: a stable random <code>userId</code> minted at first login,
				stored in the user directory (<code>users/</code>), the way a real app keeps it as a column on the account row
				(opaque, no PII in object keys, and stable for life so a rename never disturbs the key hierarchy). Users appear here once they've posted (generation 0 is minted
				lazily by the first encryption).
			</p>
			{#each data.subjects as s (s.subject)}
				<div class="subject">
					<div class="subjecthead">
						<strong>{nameOf(s.subject)}</strong>
						<code class="mono dim">{s.subject}</code>
						{#if s.tombstone === null || s.tombstone.state === 'cancelled'}
							<span class="chip live">live</span>
						{:else if s.tombstone.state === 'pending'}
							{#if remainingMs(s.tombstone) > 0}
								<span class="chip pending">
									shred pending — hard delete in {fmtRemaining(remainingMs(s.tombstone))}
								</span>
							{:else}
								<span class="chip pending">shred pending — waiting period elapsed, run the sweeper</span>
							{/if}
						{:else}
							<span class="chip committing">shredded — keys destroyed</span>
						{/if}
					</div>
					{#if s.generations.length > 0}
						<table class="gens">
							<thead><tr><th>keyId</th><th>created</th><th>wrapped key</th><th>object</th></tr></thead>
							<tbody>
								{#each s.generations as g (g.keyId)}
									<tr>
										<td><code>{g.keyId}</code></td>
										<td>{fmtTime(g.createdAt)}</td>
										<td><code class="dim">{g.wrappedKeyPreview}</code></td>
										<td><a href="/store" class="mono dim">{g.objectKey}</a></td>
									</tr>
								{/each}
							</tbody>
						</table>
					{:else if s.tombstone && s.tombstone.state === 'committing'}
						<p class="gone">
							No key objects remain — the ciphertext in the log and every cached feed page is now
							permanently unreadable.
						</p>
					{:else}
						<p class="gone">No keys yet.</p>
					{/if}
				</div>
			{/each}
		</section>

		<section class="card">
			<div class="cardhead">
				<h2>Shred sweeper</h2>
				<button class="pill" disabled={busy.sweep} onclick={() => call('sweep', '/api/shred/sweep')}>
					{busy.sweep ? 'Sweeping…' : '🧹 Run sweeper'}
				</button>
			</div>
			<p class="cardnote">
				The one clock-driven job: it executes hard deletes for shreds whose waiting period
				({Math.round(data.waitingPeriodMs / 1000)}s in this demo) has elapsed, and reconciles
				cancellations. Run it early and the shred stays in <code>openSubjects</code>, untouched —
				a real deployment runs this on a cron.
			</p>
			{#if sweepReport}
				<div class="kv report">
					<span>hard-deleted</span>
					<span>{sweepReport.hardDeleted.length ? sweepReport.hardDeleted.map(nameOf).join(', ') : '—'}</span>
					<span>reconciled cancellations</span>
					<span>{sweepReport.reconciledCancellations.length ? sweepReport.reconciledCancellations.map(nameOf).join(', ') : '—'}</span>
					<span>still waiting</span>
					<span>{sweepReport.openSubjects.length ? sweepReport.openSubjects.map(nameOf).join(', ') : '—'}</span>
				</div>
			{/if}
		</section>

		<section class="card">
			<h2>Audit stream — <code>$system.key-audit</code></h2>
			<p class="cardnote">
				Intent-first: every shred starts life as a <code>ShredRequested</code> event appended
				<em>before</em> anything is soft-deleted, so a crash leaves a visible dangling intent,
				never a silent shred. Key mints and rotations land here too. This is itself an event
				stream in the bucket (<a href="/store" class="mono">{data.auditStreamKey}/…</a>) —
				reserved, so the public feed route won't serve it.
			</p>
			{#if data.audit.length === 0}
				<p class="gone">No key activity yet — post a message to mint the first key.</p>
			{:else}
				<table class="gens">
					<thead><tr><th>#</th><th>event</th><th>subject</th><th>at</th></tr></thead>
					<tbody>
						{#each data.audit as a (a.version)}
							<tr>
								<td class="dim">{a.version}</td>
								<td><code>{a.type}</code></td>
								<td>{a.subjectId ? nameOf(a.subjectId) : '—'}</td>
								<td class="dim">{fmtTime(a.ts)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
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
		max-width: 52ch;
	}
	.nav {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
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
	.body {
		padding: 1rem 1.1rem 3rem;
	}
	.note {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 0 0 1rem;
		line-height: 1.55;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		padding: 0.85rem 1rem;
		margin-bottom: 0.9rem;
	}
	.cardhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	h2 {
		margin: 0 0 0.35rem;
		font-size: 0.95rem;
	}
	.cardnote {
		font-size: 0.76rem;
		color: var(--muted);
		margin: 0.2rem 0 0.7rem;
		line-height: 1.5;
	}
	.btns {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.pill {
		font-size: 0.78rem;
		padding: 0.35rem 0.8rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}
	.pill:hover:not(:disabled) {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.pill:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.pill.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		color: var(--danger);
	}
	.pill.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		border-color: var(--danger);
	}
	.kv {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.8rem;
		font-size: 0.78rem;
		margin-top: 0.4rem;
	}
	.kv > span:nth-child(odd) {
		color: var(--muted);
	}
	.kv.report {
		margin-top: 0.2rem;
	}
	.subject {
		border-top: 1px solid var(--border);
		padding: 0.6rem 0;
	}
	.subject:first-of-type {
		border-top: none;
	}
	.subjecthead {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.35rem;
	}
	.chip {
		font-size: 0.68rem;
		font-weight: 600;
		padding: 0.12rem 0.5rem;
		border-radius: 999px;
	}
	.chip.live {
		background: color-mix(in srgb, #16a34a 18%, transparent);
		color: #16a34a;
	}
	.chip.pending {
		background: color-mix(in srgb, #d97706 18%, transparent);
		color: #d97706;
	}
	.chip.committing {
		background: color-mix(in srgb, var(--danger) 18%, transparent);
		color: var(--danger);
	}
	.gens {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.74rem;
	}
	.gens th {
		text-align: left;
		color: var(--muted);
		font-weight: 600;
		padding: 0.2rem 0.6rem 0.2rem 0;
	}
	.gens td {
		padding: 0.2rem 0.6rem 0.2rem 0;
		border-top: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	.mono,
	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.dim {
		color: var(--muted);
		font-size: 0.72rem;
	}
	.gone {
		font-size: 0.76rem;
		color: var(--muted);
		font-style: italic;
		margin: 0.2rem 0 0;
	}
	a.mono {
		color: inherit;
	}
	@media (max-width: 640px) {
		header {
			flex-direction: column;
			align-items: stretch;
			gap: 0.55rem;
		}
	}
</style>
