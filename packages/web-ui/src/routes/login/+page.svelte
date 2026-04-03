<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types.js';

	let { form }: { form: ActionData } = $props();
	let loading = $state(false);

	const isDE = typeof navigator !== 'undefined' && navigator.language.startsWith('de');
</script>

<svelte:head>
	<title>Login — lynox</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-bg px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 flex flex-col items-center gap-4">
			<img src="/logo.svg" alt="lynox" class="h-20" />
			<p class="text-sm text-text-muted">{isDE ? 'Access Token eingeben um fortzufahren.' : 'Enter your access token to continue.'}</p>
		</div>

		<form
			method="POST"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					loading = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			{#if form?.error}
				<div
					class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
				>
					{form.error}
				</div>
			{/if}

			<div>
				<label for="token" class="mb-1.5 block text-sm text-text-muted">Access Token</label>
				<input
					id="token"
					name="token"
					type="password"
					autocomplete="current-password"
					required
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5 text-text
						placeholder:text-text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="w-full rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white
					transition-colors hover:bg-accent-hover disabled:opacity-50"
			>
				{loading ? (isDE ? 'Wird geprüft...' : 'Verifying...') : (isDE ? 'Weiter' : 'Continue')}
			</button>
		</form>

		<p class="mt-6 text-center text-xs text-text-subtle">
			{isDE ? 'Token verloren?' : 'Lost it?'} <code class="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-xs">docker logs lynox</code>
		</p>
	</div>
</div>
