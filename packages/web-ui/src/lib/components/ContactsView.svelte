<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface Contact { name: string; email?: string; phone?: string; company?: string; type?: string; source?: string; tags?: string[]; notes?: string; _created_at?: string; }
	interface Interaction { type: string; channel: string; summary: string; date?: string; }
	interface Deal { title: string; contact_name: string; value?: number; currency?: string; stage?: string; next_action?: string; }

	let tab = $state<'contacts' | 'deals'>('contacts');
	let contacts = $state<Contact[]>([]);
	let deals = $state<Deal[]>([]);
	let loading = $state(true);
	let selected = $state<Contact | null>(null);
	let interactions = $state<Interaction[]>([]);
	let error = $state('');

	async function loadContacts() {
		loading = true; error = '';
		try {
			const res = await fetch(`${getApiBase()}/crm/contacts?limit=50`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { contacts: Contact[] };
			contacts = data.contacts;
		} catch { error = t('common.load_failed'); }
		loading = false;
	}

	async function loadDeals() {
		loading = true; error = '';
		try {
			const res = await fetch(`${getApiBase()}/crm/deals?limit=50`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { deals: Deal[] };
			deals = data.deals;
		} catch { error = t('common.load_failed'); }
		loading = false;
	}

	async function selectContact(c: Contact) {
		selected = c;
		try {
			const res = await fetch(`${getApiBase()}/crm/contacts/${encodeURIComponent(c.name)}/interactions`);
			const data = (await res.json()) as { interactions: Interaction[] };
			interactions = data.interactions;
		} catch { interactions = []; }
	}

	let hasDeals = $state(false);

	async function checkDeals() {
		try {
			const res = await fetch(`${getApiBase()}/crm/deals?limit=1`);
			if (res.ok) {
				const data = (await res.json()) as { deals: Deal[] };
				hasDeals = data.deals.length > 0;
			}
		} catch { /* */ }
	}

	$effect(() => {
		loadContacts();
		checkDeals();
	});

	$effect(() => { if (tab === 'deals') loadDeals(); });

	const stageColors: Record<string, string> = {
		lead: 'bg-bg-muted text-text-muted', qualified: 'bg-accent/10 text-accent-text',
		proposal: 'bg-warning/15 text-warning', negotiation: 'bg-warning/15 text-warning',
		won: 'bg-success/15 text-success', lost: 'bg-danger/15 text-danger',
	};
</script>

<div class="p-6 max-w-5xl mx-auto">
	<div class="flex items-center gap-4 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('crm.title')}</h1>
		{#if hasDeals}
			<div class="flex gap-1">
				<button onclick={() => tab = 'contacts'} class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm {tab === 'contacts' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}">{t('crm.title')}</button>
				<button onclick={() => { tab = 'deals'; loadDeals(); }} class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm {tab === 'deals' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}">{t('crm.deals')}</button>
			</div>
		{/if}
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if tab === 'contacts'}
		{#if contacts.length === 0}
			<p class="text-text-subtle text-sm">{t('crm.no_contacts')}</p>
		{:else}
			<div class="flex gap-4">
				<div class="flex-1 space-y-1.5">
					{#each contacts as contact}
						<button onclick={() => selectContact(contact)}
							class="w-full text-left rounded-[var(--radius-md)] border px-4 py-3 transition-all {selected?.name === contact.name ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-subtle hover:border-border-hover'}">
							<div class="flex items-center justify-between">
								<span class="text-sm font-medium">{contact.name}</span>
								{#if contact.type}<span class="text-xs rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-text-muted">{contact.type}</span>{/if}
							</div>
							<div class="flex gap-2 mt-1 text-xs text-text-subtle">
								{#if contact.company}<span>{contact.company}</span>{/if}
								{#if contact.email}<span>{contact.email}</span>{/if}
							</div>
						</button>
					{/each}
				</div>
				{#if selected}
					<div class="w-80 shrink-0 rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3 self-start">
						<h2 class="font-medium">{selected.name}</h2>
						{#if selected.email}<p class="text-xs text-text-muted">{selected.email}</p>{/if}
						{#if selected.company}<p class="text-xs text-text-muted">{selected.company}</p>{/if}
						{@const parsedTags = Array.isArray(selected.tags) ? selected.tags : typeof selected.tags === 'string' ? (() => { try { return JSON.parse(selected.tags) as string[]; } catch { return []; } })() : []}
						{#if parsedTags.length > 0}
							<div class="flex flex-wrap gap-1">{#each parsedTags as tag}<span class="rounded-[var(--radius-sm)] bg-accent/10 text-accent-text px-2 py-0.5 text-xs">{tag}</span>{/each}</div>
						{/if}
						{#if interactions.length > 0}
							<p class="text-xs font-mono uppercase tracking-widest text-text-subtle">{t('crm.interactions')} ({interactions.length})</p>
							<div class="space-y-2 max-h-64 overflow-y-auto">
								{#each interactions as i}
									<div class="border-l-2 border-border pl-3">
										<p class="text-xs text-text-muted"><span class="text-accent-text">{i.type}</span> via {i.channel}</p>
										<p class="text-xs text-text-subtle">{i.summary}</p>
										{#if i.date}<p class="text-[10px] text-text-subtle">{new Date(i.date).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US')}</p>{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{:else}
		{#if deals.length === 0}
			<p class="text-text-subtle text-sm">{t('crm.no_deals')}</p>
		{:else}
			<div class="space-y-1.5">
				{#each deals as deal}
					<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium">{deal.title}</span>
							<span class="text-xs rounded-[var(--radius-sm)] px-1.5 py-0.5 {stageColors[deal.stage ?? ''] ?? 'bg-bg-muted text-text-muted'}">{deal.stage}</span>
						</div>
						<div class="flex gap-3 mt-1 text-xs text-text-muted">
							<span>{deal.contact_name}</span>
							{#if deal.value}<span>{deal.currency ?? 'CHF'} {deal.value.toLocaleString()}</span>{/if}
							{#if deal.next_action}<span class="text-text-subtle">{deal.next_action}</span>{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
