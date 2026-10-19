<script lang="ts">
	// === Connection form of a profile on a built-in provider ===
	//
	// The one place the owner enters the Client ID and Client Secret of the app they created at
	// the provider (bexio, Shopify). The engine stores both under names the provider's id derives
	// and refuses the secret everywhere else, the chat and the free secret write included, so this
	// form is the only way in. The secret is sent once in the PUT body and never comes back: the
	// engine only says whether one is stored.
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import { presetProviderLabel } from '../utils/preset-provider-label.js';

	let { profileId }: { profileId: string } = $props();

	interface ClientState {
		preset: string;
		client_id: string | null;
		client_secret_set: boolean;
		redirect_uri: string;
	}

	let client = $state<ClientState | null>(null);
	let loadFailed = $state(false);
	let clientId = $state('');
	let clientSecret = $state('');
	// With a secret stored the input stays hidden until the owner asks to replace it, so a save
	// that only corrects the Client ID cannot clear the stored secret by accident.
	let replacing = $state(false);
	let saving = $state(false);
	let notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	const provider = $derived(client ? presetProviderLabel(client.preset) : '');
	const secretInputShown = $derived(client !== null && (!client.client_secret_set || replacing));
	const canSave = $derived(
		client !== null && !saving && clientId.trim() !== '' && (secretInputShown ? clientSecret.trim() !== '' : true),
	);

	function url(): string {
		return `${getApiBase()}/api-profiles/${encodeURIComponent(profileId)}/client`;
	}

	async function load(): Promise<void> {
		loadFailed = false;
		try {
			const res = await fetch(url());
			if (!res.ok) throw new Error();
			const data = (await res.json()) as ClientState;
			client = data;
			clientId = data.client_id ?? '';
		} catch {
			loadFailed = true;
		}
	}

	async function save(): Promise<void> {
		if (!canSave || !client) return;
		saving = true;
		notice = null;
		const body: { client_id: string; client_secret?: string } = { client_id: clientId.trim() };
		if (secretInputShown) body.client_secret = clientSecret;
		try {
			const res = await fetch(url(), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (res.status === 403) {
				notice = { kind: 'error', text: t('integrations.preset_client_owner_only') };
			} else if (!res.ok) {
				notice = { kind: 'error', text: t('integrations.preset_client_save_failed') };
			} else {
				// The secret leaves the page once it is stored: the field is emptied and closed, and
				// what is shown from here on is the engine's own "is saved".
				clientSecret = '';
				replacing = false;
				client = { ...client, client_id: body.client_id, client_secret_set: client.client_secret_set || body.client_secret !== undefined };
				notice = { kind: 'ok', text: t('integrations.preset_client_saved') };
			}
		} catch {
			notice = { kind: 'error', text: t('integrations.preset_client_save_failed') };
		}
		saving = false;
	}

	$effect(() => { void profileId; void load(); });
</script>

{#if loadFailed}
	<p class="text-xs text-danger">{t('common.load_failed')}</p>
{:else if client}
	<div class="space-y-3" data-testid="preset-client-form">
		<p class="text-xs font-mono uppercase tracking-widest text-text-subtle">{tf('integrations.preset_client_title', { provider })}</p>
		<p class="text-sm text-text-muted">{tf('integrations.preset_client_intro', { provider })}</p>
		<p class="text-xs text-warning">{t('integrations.preset_client_never_chat')}</p>

		<div>
			<p class="text-xs text-text-muted mb-1">{tf('integrations.preset_client_redirect_label', { provider })}</p>
			<p class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-xs font-mono text-text-muted select-all break-all">{client.redirect_uri}</p>
		</div>

		<label class="block">
			<span class="text-xs text-text-muted">{t('integrations.preset_client_id_label')}</span>
			<input
				bind:value={clientId}
				type="text"
				autocomplete="off"
				spellcheck="false"
				class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
			/>
		</label>

		{#if secretInputShown}
			<label class="block">
				<span class="text-xs text-text-muted">{t('integrations.preset_client_secret_label')}</span>
				<input
					bind:value={clientSecret}
					type="password"
					autocomplete="off"
					data-testid="preset-client-secret"
					class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
				/>
			</label>
		{:else}
			<div class="flex items-center justify-between gap-3">
				<p class="text-xs text-text-muted">{t('integrations.preset_client_secret_set')}</p>
				<button
					onclick={() => { replacing = true; }}
					class="text-xs text-text-subtle hover:text-text-muted transition-colors"
				>
					{t('integrations.preset_client_replace')}
				</button>
			</div>
		{/if}

		<button
			onclick={save}
			disabled={!canSave}
			class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
		>
			{saving ? t('common.saving') : t('common.save')}
		</button>

		{#if notice}
			<p class="text-xs {notice.kind === 'ok' ? 'text-success' : 'text-danger'}" role="status">{notice.text}</p>
		{/if}
	</div>
{/if}
