<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<div class="wrap">
	<div class="card">
		<div class="badge">💬</div>
		<h1>s3-event-store chat</h1>
		<p class="tagline">
			A multi-user chat where every message, edit, and delete is an immutable event appended to a
			single stream in object storage. Pick a name to jump in.
		</p>

		<form method="POST" use:enhance>
			<label for="username">Username</label>
			<input
				id="username"
				name="username"
				autocomplete="off"
				placeholder="e.g. alice"
				maxlength="32"
				value={form?.username ?? ''}
				autofocus
			/>
			{#if form?.error}
				<p class="error">{form.error}</p>
			{/if}
			<button type="submit">Join the chat →</button>
		</form>

		<p class="note">No password. No account. Just a name — this is a demo.</p>
	</div>
</div>

<style>
	.wrap {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}
	.card {
		width: min(28rem, 100%);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 2rem;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
	}
	.badge {
		font-size: 2.5rem;
		line-height: 1;
	}
	h1 {
		margin: 0.75rem 0 0.25rem;
		font-size: 1.5rem;
	}
	.tagline {
		color: var(--muted);
		margin: 0 0 1.5rem;
		line-height: 1.5;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--muted);
	}
	input {
		padding: 0.7rem 0.85rem;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--input-bg);
		color: inherit;
		font-size: 1rem;
	}
	input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	button {
		margin-top: 0.5rem;
		padding: 0.7rem;
		border: none;
		border-radius: 10px;
		background: var(--accent);
		color: #fff;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
	}
	button:hover {
		filter: brightness(1.08);
	}
	.error {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 0.15rem 0 0;
	}
	.note {
		margin: 1.25rem 0 0;
		font-size: 0.8rem;
		color: var(--muted);
		text-align: center;
	}
</style>
