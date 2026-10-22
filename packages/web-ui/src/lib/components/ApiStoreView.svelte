<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { getLocale, t, tf } from '../i18n.svelte.js';
	import { apiDeleteNotice } from '../utils/api-delete-notice.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import Icon from '../primitives/Icon.svelte';
	import PresetClientForm from './PresetClientForm.svelte';
	import { connectionLine, type ConnectionLine, type OAuthGrantView } from '../utils/oauth-connection.js';
	import { localDay, noticesByProfile, revocationView, type ProviderNotice } from '../utils/provider-revocation.js';
	import { connectHref } from '../oauth-connect-path.js';

	interface ApiEndpoint { method: string; path: string; description: string; }
	interface ApiProfile { id: string; name: string; base_url: string; description: string; auth?: { type: string; oauth?: { preset_id?: string } }; endpoints?: ApiEndpoint[]; guidelines?: string[]; oauth_grant?: OAuthGrantView & { state?: unknown; revoked_at?: unknown }; }

	// Who connected the profile and with which provider account (`utils/oauth-connection.ts`).
	function connectionText(line: ConnectionLine): string {
		const who = line.by.kind === 'you' ? t('apis.connected_by_you')
			: tf('apis.connected_by', { who: line.by.kind === 'helper' ? line.by.address : line.by.tag });
		const account = line.account === null ? t('apis.account_unknown') : tf('apis.account', { account: line.account });
		return `${who} · ${account}`;
	}

	// A profile on a built-in provider gets its app credentials through its own form, not the chat.
	function onBuiltInProvider(p: ApiProfile): boolean {
		return p.auth?.type === 'oauth2' && typeof p.auth.oauth?.preset_id === 'string' && p.auth.oauth.preset_id !== '';
	}

	// A file the import of the earlier profiles waits on (`ApiStore.importWaitsOn`).
	interface ImportWait { file: string; reason: 'unread' | 'malformed' | 'not_a_profile' | 'invalid_id'; deleteId: string | null; }
	const WAIT_REASON: Record<ImportWait['reason'], string> = {
		unread: 'apis.import_waiting_unread',
		malformed: 'apis.import_waiting_malformed',
		not_a_profile: 'apis.import_waiting_not_a_profile',
		invalid_id: 'apis.import_waiting_invalid_id',
	};

	let profiles = $state<ApiProfile[]>([]);
	let importWaiting = $state<ImportWait[]>([]);
	let loading = $state(true);
	let expanded = $state<string | null>(null);
	let deleting = $state<string | null>(null);
	let error = $state('');
	// What the last delete left in the vault, one sentence per kind (see `apiDeleteNotice`).
	let left = $state<string[]>([]);
	// The pending erasures a provider's revocation started, by profile id. Owner-only: a mandate's
	// page gets a refusal and shows no notice; so does any other failure.
	let notices = $state<Map<string, ProviderNotice>>(new Map());
	// The time the notices are read against, moved on each minute: a hold or a deadline that passes
	// while the page is open takes the way out and the dates away without a reload.
	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => { now = new Date(); }, 60_000);
		return () => clearInterval(timer);
	});

	async function loadNotices() {
		try {
			const res = await fetch(`${getApiBase()}/connections/records`);
			notices = res.ok ? noticesByProfile(await res.json()) : new Map();
		} catch {
			notices = new Map();
		}
	}

	async function loadProfiles() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/api-profiles`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { profiles: ApiProfile[]; importWaiting?: ImportWait[] };
			profiles = data.profiles;
			importWaiting = data.importWaiting ?? [];
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function deleteProfile(profile: ApiProfile) {
		// Native confirm keeps the surface small; matches the rest of the
		// destructive-action UX in this app (HistoryView, ArtifactsView).
		const msg = t('apis.delete_confirm').replace('{name}', profile.name);
		if (!confirm(msg)) return;
		deleting = profile.id;
		error = '';
		left = [];
		try {
			const res = await fetch(`${getApiBase()}/api-profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			left = apiDeleteNotice(await res.json().catch(() => null), tf);
			profiles = profiles.filter(p => p.id !== profile.id);
			if (expanded === profile.id) expanded = null;
		} catch {
			error = t('apis.delete_failed');
		}
		deleting = null;
	}

	// API integrations are set up + managed by talking to the agent (api_setup,
	// with secrets collected out-of-band via ask_secret so they never enter the
	// chat) — not a bespoke form. "New API" opens a fresh chat to bootstrap one;
	// "Manage in chat" seeds the chat with the profile id so the agent can
	// api_setup view/update/delete it. The id is app-generated, but the name is
	// agent/user-authored so it passes through the client-side sanitiser.
	function createInChat(): void {
		newChat();
		void sendMessage(t('apis.create_in_chat_prompt'));
		void goto('/app');
	}

	function manageInChat(p: ApiProfile): void {
		newChat();
		const name = sanitizeFramingField(p.name);
		const id = sanitizeFramingField(p.id, 80);
		void sendMessage(`${t('apis.manage_in_chat_prompt')} ${name} (id: ${id}).`);
		void goto('/app');
	}

	$effect(() => { void loadProfiles(); /* catches and sets its error */ void loadNotices(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('apis.title')}</h1>
		<button onclick={createInChat} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">+ {t('apis.create_in_chat')}</button>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}
	{#if left.length > 0}
		<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning mb-4 space-y-1" role="status" data-testid="api-delete-left">
			{#each left as line}<p>{line}</p>{/each}
		</div>
	{/if}

	{#if importWaiting.length > 0}
		<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning mb-4 space-y-1" role="status" data-testid="api-import-waiting">
			<p>{t('apis.import_waiting')}</p>
			<ul class="list-disc pl-5 space-y-1">
				{#each importWaiting as w (w.file)}
					<li><span class="font-mono">{w.file}</span> {t(WAIT_REASON[w.reason] ?? 'apis.import_waiting_not_a_profile')}. {w.deleteId === null ? t('apis.import_waiting_by_hand') : tf('apis.import_waiting_delete', { id: w.deleteId })}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if profiles.length === 0}
		<p class="text-text-subtle text-sm">{t('apis.no_profiles')}</p>
	{:else}
		<div class="space-y-2">
			{#each profiles as profile}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<div class="flex items-stretch">
						<button onclick={() => expanded = expanded === profile.id ? null : profile.id}
							class="flex-1 px-4 py-3 text-left hover:bg-bg-muted transition-colors">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium">{profile.name}</span>
								{#if profile.auth}<span class="text-xs rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-text-muted">{profile.auth.type}</span>{/if}
							</div>
							<p class="text-xs text-text-subtle mt-1 font-mono">{profile.base_url}</p>
							{#if connectionLine(profile.oauth_grant)}<p class="text-xs text-text-muted mt-1" data-testid="api-connection">{connectionText(connectionLine(profile.oauth_grant)!)}</p>{/if}
							{#if profile.description}<p class="text-xs text-text-muted mt-1">{profile.description}</p>{/if}
						</button>
						<button onclick={() => manageInChat(profile)}
							aria-label={t('apis.manage_in_chat')}
							title={t('apis.manage_in_chat')}
							class="px-3 text-sm text-text-subtle hover:text-text hover:bg-bg-muted transition-colors border-l border-border">
							<Icon name="chat" size="xs" />
						</button>
						<button onclick={() => deleteProfile(profile)}
							disabled={deleting === profile.id}
							aria-label={t('apis.delete')}
							class="px-3 text-xs text-text-subtle hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-l border-border">
							{t('apis.delete')}
						</button>
					</div>
					{#if revocationView(profile.oauth_grant, notices.get(profile.id), now)}
						{@const view = revocationView(profile.oauth_grant, notices.get(profile.id), now)!}
						<div class="border-t border-border px-4 py-3 space-y-2 text-xs text-text-muted" data-testid="api-revoked">
							{#if view.kind === 'revoked' || view.kind === 'pending'}
								{@const since = view.kind === 'revoked' ? view.revokedAt : view.notice.revokedAt}
								{#if since}<p>{tf('apis.revoked_on', { date: localDay(since, getLocale()) })}</p>{/if}
							{/if}
							{#if view.notice}
								{@const dates = { revoked: localDay(view.notice.revokedAt, getLocale()), earliest: localDay(view.notice.holdUntil, getLocale()), latest: localDay(view.notice.deadline, getLocale()) }}
								<p data-testid="api-erasure-window">{tf('apis.erasure_window', dates)}</p>
								{#if view.kind === 'revoked'}
									<p data-testid="api-erasure-notice">{tf('apis.erasure_notice', dates)}</p>
								{:else if view.kind === 'reconnected'}
									<p data-testid="api-erasure-reconnected">{tf('apis.erasure_reconnected_notice', { ...dates, who: view.who })}</p>
									{#if view.avertable}<p data-testid="api-erasure-avert">{tf('apis.erasure_reconnected_avert', { who: view.who })}</p>{/if}
								{:else if view.kind === 'connectedAgain'}
									<p data-testid="api-erasure-connected-again">{tf('apis.erasure_connected_again_notice', dates)}</p>
								{/if}
							{/if}
							{#if view.kind === 'revoked' || view.kind === 'connectedAgain' || (view.kind === 'reconnected' && view.avertable)}
								<!-- A full page load: the engine's route answers with a page or a redirect to the provider. -->
								<a href={connectHref(getApiBase(), profile.id)} data-sveltekit-reload data-testid="api-reconnect"
									class="inline-block rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
							{/if}
						</div>
					{/if}
					{#if onBuiltInProvider(profile)}
						<div class="border-t border-border px-4 py-3">
							<PresetClientForm profileId={profile.id} />
						</div>
					{/if}
					{#if expanded === profile.id && profile.endpoints && profile.endpoints.length > 0}
						<div class="border-t border-border px-4 py-3 space-y-1">
							<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-2">{t('apis.endpoints')} ({profile.endpoints.length})</p>
							{#each profile.endpoints as ep}
								<div class="flex gap-2 text-xs">
									<span class="rounded-[var(--radius-sm)] bg-accent/10 text-accent-text px-1.5 py-0.5 font-mono">{ep.method}</span>
									<span class="font-mono text-text-muted">{ep.path}</span>
									<span class="text-text-subtle">{ep.description}</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
