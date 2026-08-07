<!--
	Calendar channel — connect a read-only ICS feed.

	Its own page rather than a row in the generic secrets list, because the value is not an API
	key the operator already has in hand: it is a link buried three clicks deep in their calendar
	provider, and nobody finds it without being told where. The generic list would render
	`CALENDAR_FEED_MAIN` as a name/value pair and leave the finding of it as an exercise.

	The address IS the credential — anyone holding it can read the whole calendar — so it is
	stored under a `CALENDAR_FEED_*` name, which `isInfraSecret` keeps out of the agent's session
	briefing and out of `secret:` tool-input resolution. It is NOT admin-only, though: it is the
	one such name only the operator can possibly know (see USER_OWNED_INFRA_PATTERNS in
	http-api.ts), so a managed customer sets it here without a support ticket.

	Read-only by construction: an ICS feed has no write side, which is exactly why this works
	without OAuth, a Google Cloud project, or the unresettable 100-user cap that comes with an
	unverified app on a sensitive scope.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	const PREFIX = 'CALENDAR_FEED_';

	let feeds = $state<string[]>([]);
	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);

	// Add-form state
	let label = $state('MAIN');
	let url = $state('');

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			if (!res.ok) {
				error = t('calendar.load_failed');
				return;
			}
			const data = (await res.json()) as { names: string[] };
			feeds = data.names.filter(n => n.startsWith(PREFIX)).map(n => n.slice(PREFIX.length)).sort();
		} catch {
			error = t('calendar.load_failed');
		} finally {
			loading = false;
		}
	}

	function normalisedLabel(): string {
		// Upper-snake, because it becomes part of the vault key. Anything else the operator types
		// (spaces, umlauts, punctuation) would land in a name the engine then cannot match.
		return label.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
	}

	async function save(): Promise<void> {
		const name = normalisedLabel();
		const value = url.trim();
		if (!name) { error = t('calendar.label_required'); return; }
		if (!/^https:\/\//u.test(value)) { error = t('calendar.https_required'); return; }
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/${PREFIX}${name}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				error = body.error ?? t('calendar.save_failed');
				return;
			}
			// The value is never read back — the API returns names only, by design. Clearing the
			// field is therefore also the honest UI: what is stored cannot be shown again.
			url = '';
			await load();
		} catch {
			error = t('calendar.save_failed');
		} finally {
			saving = false;
		}
	}

	async function remove(name: string): Promise<void> {
		saving = true;
		try {
			await fetch(`${getApiBase()}/secrets/${PREFIX}${name}`, { method: 'DELETE' });
			await load();
		} catch {
			error = t('calendar.save_failed');
		} finally {
			saving = false;
		}
	}

	void load();
</script>

<div class="p-6 max-w-2xl mx-auto space-y-6">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels')}</a>
	<div>
		<h1 class="text-xl font-light tracking-tight mt-2">{t('calendar.title')}</h1>
		<p class="text-sm text-text-muted mt-2">{t('calendar.intro')}</p>
	</div>

	<section class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-2">
		<h2 class="text-sm font-medium">{t('calendar.where_title')}</h2>
		<ol class="text-sm text-text-muted space-y-1 list-decimal list-inside">
			<li>{t('calendar.where_google')}</li>
			<li>{t('calendar.where_outlook')}</li>
			<li>{t('calendar.where_apple')}</li>
		</ol>
		<p class="text-xs text-text-subtle pt-1">{t('calendar.secrecy_note')}</p>
	</section>

	{#if loading}
		<p class="text-sm text-text-muted">{t('common.loading')}</p>
	{:else}
		{#if feeds.length > 0}
			<section class="space-y-2">
				<h2 class="text-sm font-medium">{t('calendar.connected')}</h2>
				{#each feeds as name}
					<div class="flex items-center justify-between rounded-[var(--radius-md)] border border-border p-3">
						<span class="text-sm">{name}</span>
						<button
							type="button"
							class="text-xs text-text-subtle hover:text-danger transition-colors"
							disabled={saving}
							onclick={() => void remove(name)}
						>{t('common.remove')}</button>
					</div>
				{/each}
			</section>
		{/if}

		<section class="space-y-3">
			<h2 class="text-sm font-medium">{feeds.length > 0 ? t('calendar.add_another') : t('calendar.add_first')}</h2>
			<label class="block space-y-1">
				<span class="text-xs text-text-muted">{t('calendar.label')}</span>
				<input
					bind:value={label}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm"
					placeholder="MAIN"
				/>
			</label>
			<label class="block space-y-1">
				<span class="text-xs text-text-muted">{t('calendar.address')}</span>
				<input
					bind:value={url}
					type="password"
					autocomplete="off"
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono"
					placeholder="https://…/basic.ics"
				/>
			</label>
			<button
				type="button"
				class="rounded-[var(--radius-md)] bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-50"
				disabled={saving}
				onclick={() => void save()}
			>{saving ? t('common.saving') : t('calendar.connect')}</button>
		</section>
	{/if}

	{#if error}
		<p class="text-sm text-danger">{error}</p>
	{/if}
</div>
