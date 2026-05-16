<!--
	Secrets View — generic API-key CRUD (Tavily / Brevo / custom-named).
	PRD-IA-CONSOLIDATION-V2 Phase 1 P1-PR-A1: own sub-page at /settings/llm/keys.

	Distinct from LLM provider keys (ANTHROPIC_API_KEY / MISTRAL_API_KEY / etc.),
	which live in the per-provider Card on `/settings/llm`. Hides those slots
	from the list so the surface stays "everything that ISN'T the LLM key".

	Backend: reuses the existing /api/secrets endpoints already wired for KeysView.
	On managed tiers PUT is allowlisted (BYOK_USER_WRITABLE_SECRETS in http-api.ts)
	to just ANTHROPIC_API_KEY + OPENAI_API_KEY — so generic-key creation will 403.
	We surface a managed-info notice instead of failing silently.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { clearError } from '../stores/chat.svelte.js';

	// Provider-owned slots — these belong on /settings/llm, NOT here.
	// Hiding them from the list keeps SSoT intact: editing an Anthropic key
	// from two places would race against the LLM-settings save path.
	const PROVIDER_SLOTS = new Set([
		'ANTHROPIC_API_KEY',
		'MISTRAL_API_KEY',
		'OPENAI_API_KEY',
		'CUSTOM_API_KEY',
	]);

	// Channel-managed secrets — owned by their own Settings sub-page (Mail
	// accounts under Integrations → Mail, WhatsApp under .../whatsapp, etc.).
	// Showing them in the generic-keys list confuses operators because the
	// "Ändern" button here writes to a different code path than the channel's
	// edit form, races silently, and the names (e.g. MAIL_ACCOUNT_STAGING_RULE)
	// don't read as "API keys" the way TAVILY_API_KEY does. Filter by prefix.
	const CHANNEL_MANAGED_PREFIXES: ReadonlyArray<string> = [
		'MAIL_ACCOUNT_',
		'WHATSAPP_',
		'GOOGLE_OAUTH_',
	];
	function isChannelManaged(name: string): boolean {
		return CHANNEL_MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix));
	}

	// Suggested names — drives the "Add new key" dropdown. Free-text still works
	// for anything custom (zapier, replicate, etc.).
	const SUGGESTED_NAMES = [
		'TAVILY_API_KEY',
		'BREVO_API_KEY',
		'SEARCH_API_KEY',
		'GOOGLE_CLIENT_ID',
		'GOOGLE_CLIENT_SECRET',
		'LYNOX_BUGSINK_DSN',
	];

	let allNames = $state<string[]>([]);
	let managed = $state<boolean>(false);
	let newName = $state('TAVILY_API_KEY');
	let newValue = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');

	// Inline edit state
	let editingName = $state<string | null>(null);
	let editValue = $state('');
	let editSaving = $state(false);

	async function loadSecrets() {
		loading = true;
		error = '';
		try {
			const [secretsRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/secrets`),
				fetch(`${getApiBase()}/config`),
			]);
			if (secretsRes.ok) {
				const data = (await secretsRes.json()) as { names: string[] };
				allNames = data.names;
			} else if (secretsRes.status === 403) {
				// Self-host without admin token, or managed cookie-user without admin
				// promotion. List endpoint is admin-only — surface the gate clearly
				// instead of silently showing an empty list.
				error = t('secrets.no_admin');
			} else {
				error = t('common.load_failed');
			}
			if (configRes.ok) {
				const cfg = (await configRes.json()) as { managed?: string };
				managed = cfg.managed === 'managed' || cfg.managed === 'managed_pro' || cfg.managed === 'eu';
			}
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	// Generic-keys list = everything that's not a per-provider LLM slot
	// AND not a channel-managed prefix (mail accounts, WhatsApp BYOK, Google OAuth).
	const genericNames = $derived(allNames.filter(n => !PROVIDER_SLOTS.has(n) && !isChannelManaged(n)));

	async function saveSecret() {
		const trimmed = newName.trim();
		if (!newValue.trim() || !trimmed) return;
		// Block accidental writes to LLM slots from this surface — those have
		// their own form on /settings/llm with provider-aware validation.
		if (PROVIDER_SLOTS.has(trimmed)) {
			error = t('secrets.use_llm_page');
			return;
		}
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(trimmed)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: newValue })
			});
			if (!res.ok) {
				if (res.status === 403) {
					error = t('secrets.managed_blocked');
				} else {
					error = t('common.save_failed');
				}
				saving = false;
				return;
			}
			newValue = '';
			clearError();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	function startEdit(name: string) {
		editingName = name;
		editValue = '';
	}

	function cancelEdit() {
		editingName = null;
		editValue = '';
	}

	async function commitEdit(name: string) {
		if (!editValue.trim()) return;
		editSaving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: editValue })
			});
			if (!res.ok) {
				error = res.status === 403 ? t('secrets.managed_blocked') : t('common.save_failed');
				editSaving = false;
				return;
			}
			clearError();
			editingName = null;
			editValue = '';
		} catch {
			error = t('common.save_failed');
		}
		editSaving = false;
	}

	function onEditKeydown(e: KeyboardEvent, name: string) {
		if (e.key === 'Enter' && editValue.trim()) void commitEdit(name);
		if (e.key === 'Escape') cancelEdit();
	}

	async function deleteSecret(name: string) {
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
			if (!res.ok) {
				error = t('common.save_failed');
				return;
			}
			if (editingName === name) cancelEdit();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
	}

	$effect(() => {
		void loadSecrets();
	});
</script>

<div class="p-6 max-w-3xl mx-auto">
	<a href="/app/settings/llm" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('secrets.back_to_llm')}</a>
	<header class="mt-2 mb-4">
		<h1 class="text-2xl font-semibold mb-1">{t('secrets.title')}</h1>
		<p class="text-sm text-text-muted">{t('secrets.subtitle')}</p>
	</header>

	{#if managed}
		<!-- Managed-tier notice: BYOK_USER_WRITABLE_SECRETS in http-api.ts only
		     permits ANTHROPIC_API_KEY + OPENAI_API_KEY. Generic API-key writes
		     will 403. Surface this upfront. -->
		<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm mb-4">
			<p class="font-medium">{t('secrets.managed_notice_title')}</p>
			<p class="text-xs text-text-muted mt-1">{t('secrets.managed_notice_body')}</p>
		</div>
	{/if}

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else}
		<section aria-labelledby="secrets-list-heading" class="mb-6">
			<h2 id="secrets-list-heading" class="text-lg font-medium mb-2">{t('secrets.list_heading')}</h2>
			{#if genericNames.length > 0}
				<div class="space-y-2">
					{#each genericNames as name (name)}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<div class="flex items-center justify-between">
								<span class="font-mono text-sm">{name}</span>
								<div class="flex items-center gap-2">
									{#if editingName !== name}
										<button
											type="button"
											onclick={() => startEdit(name)}
											class="text-xs text-accent-text hover:underline"
										>
											{t('keys.edit')}
										</button>
									{/if}
									<button
										type="button"
										onclick={() => deleteSecret(name)}
										class="text-xs text-danger hover:underline"
									>
										{t('settings.delete')}
									</button>
								</div>
							</div>
							{#if editingName === name}
								<div class="flex items-center gap-2 mt-2">
									<input
										type="password"
										bind:value={editValue}
										onkeydown={(e) => onEditKeydown(e, name)}
										placeholder={t('keys.new_value')}
										autocomplete="off"
										class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
									/>
									<button
										type="button"
										onclick={() => commitEdit(name)}
										disabled={editSaving || !editValue.trim()}
										class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
									>
										{editSaving ? t('settings.saving') : t('settings.save')}
									</button>
									<button
										type="button"
										onclick={cancelEdit}
										class="text-xs text-text-subtle hover:text-text"
									>
										{t('common.cancel')}
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-text-subtle text-sm italic">{t('secrets.empty')}</p>
			{/if}
		</section>

		<section aria-labelledby="secrets-add-heading" class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
			<h2 id="secrets-add-heading" class="text-sm font-medium">{t('secrets.add_title')}</h2>
			<div>
				<label for="secret-name" class="block text-xs text-text-muted">{t('keys.name_label')}</label>
				<input
					id="secret-name"
					list="secrets-suggested-names"
					bind:value={newName}
					placeholder="TAVILY_API_KEY"
					class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
				/>
				<datalist id="secrets-suggested-names">
					{#each SUGGESTED_NAMES as suggested (suggested)}
						<option value={suggested}></option>
					{/each}
				</datalist>
				<p class="text-xs text-text-subtle mt-1">{t('secrets.name_hint')}</p>
			</div>
			<div>
				<label for="secret-value" class="block text-xs text-text-muted">{t('keys.value_label')}</label>
				<input
					id="secret-value"
					bind:value={newValue}
					type="password"
					placeholder="sk-..."
					autocomplete="off"
					class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
				/>
			</div>
			<button
				type="button"
				onclick={saveSecret}
				disabled={saving || !newValue.trim() || !newName.trim()}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50"
			>
				{saving ? t('settings.saving') : t('settings.save')}
			</button>
		</section>
	{/if}
</div>
