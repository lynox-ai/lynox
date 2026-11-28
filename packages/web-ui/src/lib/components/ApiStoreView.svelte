<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { getLocale, t, tf } from '../i18n.svelte.js';
	import { apiDeleteNotice } from '../utils/api-delete-notice.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import Icon from '../primitives/Icon.svelte';
	import PresetClientForm from './PresetClientForm.svelte';
	import MarkedLine from './MarkedLine.svelte';
	import MarkedValue from './MarkedValue.svelte';
	import { plainText, shownValue, shownWhole } from '../utils/plan-takeover.js';
	import { connectionLine, type ConnectionLine, type OAuthGrantView } from '../utils/oauth-connection.js';
	import { authChipLabel } from '../utils/api-auth-label.js';
	import { noticesByProfile, revocationView, type ProviderNotice } from '../utils/provider-revocation.js';
	import { connectHref } from '../oauth-connect-path.js';
	import { longDay, storeAccessShown, type StoreAccessEnd, type StoreAccessShown } from '../utils/store-access-end.js';
	import { placeholderParts } from '../utils/value-breaks.js';
	import WholeValue from './WholeValue.svelte';
	import { isMandateSession, isOwnerSession, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import ViewerUnavailableNotice from './settings-readonly/ViewerUnavailableNotice.svelte';

	interface ApiEndpoint { method: string; path: string; description: string; }
	interface ApiProfile { id: string; name: string; base_url: string; description: string; /** Who set it up (`owner` or `mandate:<address>`). */ created_by?: string; auth?: { type: string; oauth?: { preset_id?: string } }; endpoints?: ApiEndpoint[]; guidelines?: string[]; oauth_grant?: OAuthGrantView & { state?: unknown; revoked_at?: unknown };
		/** Whether this reader's connect start goes through: a mandate's only for a profile it set up,
		 *  the owner's on every profile but one a person with access set up. */
		reader_may_connect?: boolean;
		/** Sent only to the person who set up an oauth2 profile: whether its client pair is still
		 *  withheld from them (the owner has not released it). */
		reader_client_withheld?: boolean;
		/** A store whose access runs out soon, has, or whose refresh ended (`storeAccessEnd` in the engine). */
		store_access_ends?: StoreAccessEnd;
		/** The built-in provider the profile signs in through, by its display name; null for none (`builtInPresetOf`). */
		built_in_provider?: string | null; }

	// A profile a person with access set up, in the owner's view: its name is that person's words.
	function setUpByMember(profile: ApiProfile): boolean {
		return isOwnerSession() && (profile.created_by ?? '').startsWith('mandate:');
	}

	// The hostname of a profile's web address, or '' when it is not one. Only http(s), and only the
	// characters a host name or an IPv6 literal is made of: an opaque host (`foo://…`) keeps case and
	// punctuation, and a special one still keeps quotes, so neither reaches the dialog. Length is
	// bounded, so the question after it stays in view.
	const HOST = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}\.?$|^\[[0-9a-f:.]+\]$/;
	function hostOf(url: string): string {
		try {
			const u = new URL(url);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
			return u.hostname.length <= 253 && HOST.test(u.hostname) ? u.hostname : '';
		} catch {
			return '';
		}
	}

	// Who connected the profile and with which provider account (`utils/oauth-connection.ts`). A
	// person's address and an account's label are someone else's values, set apart (`MarkedLine`).
	// The account goes in its own box, kept whole while it fits a line (U-391): `acme-store` does
	// not break at its hyphen.
	function connectionParts(line: ConnectionLine): { lead: string; account: string | null; after: string } {
		const who = line.by.kind === 'you' ? t('apis.connected_by_you')
			: line.by.kind === 'owner' ? t('apis.connected_by_owner')
			: tf('apis.connected_by', { who: shownValue(line.by.kind === 'helper' ? line.by.address : line.by.tag) });
		if (line.withheld || line.account === null) return { lead: `${who} · ${t(line.withheld ? 'apis.account_withheld' : 'apis.account_unknown')}`, account: null, after: '' };
		const parts = placeholderParts(tf('apis.account', { account: '{account}' }), '{account}');
		return { lead: `${who} · ${parts.before}`, account: shownValue(line.account), after: parts.after };
	}

	// A profile on a built-in provider gets its app credentials through its own form, not the chat.
	function onBuiltInProvider(p: ApiProfile): boolean {
		return p.auth?.type === 'oauth2' && typeof p.auth.oauth?.preset_id === 'string' && p.auth.oauth.preset_id !== '';
	}

	// Whether the revocation view of this profile shows its own reconnect link (the markup below).
	function viewLinks(view: ReturnType<typeof revocationView>): boolean {
		return view !== null && (view.kind === 'revoked' || view.kind === 'ended' || view.kind === 'connectedAgain' || (view.kind === 'reconnected' && view.avertable));
	}

	// Never connected: the first connect is still to make, unless a revocation view already offers
	// its own reconnect link, so the two never show together. An erasure past its hold shows no
	// link of its own, and the first connect is then the way back. Whether a grant is a connection
	// is the engine's answer (`connection`): a save records a grant for every new profile before
	// anyone connected it.
	function notYetConnected(p: ApiProfile): boolean {
		return onBuiltInProvider(p) && p.oauth_grant?.connection !== true
			&& !viewLinks(revocationView(p.oauth_grant, notices.get(p.id), now));
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

	/**
	 * A store's access end on its row (U-391), before and after it, unless the revocation view says
	 * what to do instead (`revoked`, or `ended` for a refresh that ended). Beside any other view (an
	 * erasure that stands) the line shows too; its own "Reconnect" only where that view shows none.
	 */
	function accessLine(profile: ApiProfile): { access: StoreAccessShown; button: boolean } | null {
		const access = storeAccessShown(profile, now, getLocale());
		if (access === null) return null;
		const view = revocationView(profile.oauth_grant, notices.get(profile.id), now);
		if (view?.kind === 'revoked' || view?.kind === 'ended') return null;
		const viewButton = view?.kind === 'connectedAgain' || (view?.kind === 'reconnected' && view.avertable);
		return { access, button: !viewButton };
	}
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
		// A native dialog cannot set a value apart: a name a person with access gave stays out of it.
		// The host of its address names it instead, when it is a plain host name (`hostOf`).
		const host = setUpByMember(profile) ? hostOf(profile.base_url) : '';
		const msg = !setUpByMember(profile) ? tf('apis.delete_confirm', { name: profile.name })
			: host !== '' ? tf('apis.delete_confirm_host', { host }) : t('apis.delete_confirm_unnamed');
		if (!confirm(msg)) return;
		deleting = profile.id;
		error = '';
		left = [];
		try {
			const res = await fetch(`${getApiBase()}/api-profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
			if (!res.ok) {
				// An engine that started without engine.db refuses every delete; it says so with a code.
				const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
				error = t(body?.code === 'engine_less' ? 'apis.delete_engine_less' : 'apis.delete_failed');
				deleting = null;
				return;
			}
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

	$effect(() => { void loadProfiles(); /* catches and sets its error */ void loadNotices(); void loadSettingsViewer(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<ViewerUnavailableNotice />
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('apis.title')}</h1>
		<button onclick={createInChat} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">+ {t('apis.create_in_chat')}</button>
	</div>

	{#if isMandateSession()}
		<!-- A mandate's session: it sets up profiles in chat and connects its own, but
		     deleting a profile and entering a built-in provider's app credentials are the owner's. -->
		<p class="mb-4 border border-border rounded p-3 text-sm text-text-muted" data-testid="apis-owner-only">{t('apis.owner_only_notice')}</p>
	{/if}

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}
	{#if left.length > 0}
		<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning mb-4 space-y-1" role="status" data-testid="api-delete-left">
			{#each left as line}<p>{line}</p>{/each}
		</div>
	{/if}

	<!-- Repairing or deleting the waiting files is the owner's; only the owner's session is asked to. -->
	{#if importWaiting.length > 0 && isOwnerSession()}
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
							aria-expanded={expanded === profile.id}
							class="flex-1 min-w-0 px-4 py-3 text-left hover:bg-bg-muted transition-colors">
							<!-- The row wraps its items whole, at their one-line width: when the name leaves no room
							     the chip moves under it on one line. Only a chip wider than the whole row wraps its
							     text, still one box and never cut. Its own border and surface keep it apart from the
							     head's hover and open surface. -->
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="api-card-title">
								<span class="text-sm font-medium break-words" data-profile-name>{#if setUpByMember(profile)}<MarkedLine text={shownWhole(profile.name)} mono={false} />{:else}{profile.name}{/if}</span>
								{#if authChipLabel(profile.auth, profile.built_in_provider)}{@const chip = authChipLabel(profile.auth, profile.built_in_provider)!}{@const chipText = chip.values ? tf(chip.key, chip.values) : t(chip.key)}<span class="text-xs max-w-full rounded-[var(--radius-sm)] border border-border bg-bg px-1.5 py-0.5 text-text-muted" title={chipText} data-testid="api-auth-chip">{chipText}</span>{/if}
							</div>
							<!-- The address is the profile's own value: its invisible characters printed as their code
							     point (`shownWhole`), kept whole between its dots and slashes. -->
							<p class="text-xs text-text-subtle mt-1 font-mono"><WholeValue value={plainText(shownWhole(profile.base_url))} kind="url" testid="api-base-url" /></p>
							{#if connectionLine(profile.oauth_grant)}
								{@const conn = connectionParts(connectionLine(profile.oauth_grant)!)}
								<p class="text-xs text-text-muted mt-1" data-testid="api-connection"><MarkedLine text={conn.lead} />{#if conn.account !== null}<MarkedValue text={conn.account} testid="api-connection-account" />{/if}{conn.after}</p>
							{/if}
						</button>
						<button onclick={() => manageInChat(profile)}
							aria-label={t('apis.manage_in_chat')}
							title={t('apis.manage_in_chat')}
							class="shrink-0 px-3 text-sm text-text-subtle hover:text-text hover:bg-bg-muted transition-colors border-l border-border">
							<Icon name="chat" size="xs" />
						</button>
						{#if isOwnerSession()}
						<button onclick={() => deleteProfile(profile)}
							disabled={deleting === profile.id}
							aria-label={t('apis.delete')}
							class="shrink-0 px-3 text-xs text-text-subtle hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-l border-border">
							{t('apis.delete')}
						</button>
						{/if}
					</div>
					{#if revocationView(profile.oauth_grant, notices.get(profile.id), now)}
						{@const view = revocationView(profile.oauth_grant, notices.get(profile.id), now)!}
						<div class="border-t border-border px-4 py-3 space-y-2 text-xs text-text-muted" data-testid="api-revoked">
							{#if view.kind === 'revoked' || view.kind === 'pending'}
								{@const since = view.kind === 'revoked' ? view.revokedAt : view.notice.revokedAt}
								{#if since}<p>{tf('apis.revoked_on', { date: longDay(since, getLocale()) })}</p>{/if}
							{:else if view.kind === 'ended'}
								<p data-testid="api-access-ended">{t('apis.access_ended')}</p>
							{/if}
							<!-- First the dates and the way out with its button; the long text below, closed. -->
							{#if view.notice}
								<p data-testid="api-erasure-window">{tf('apis.erasure_window', { earliest: longDay(view.notice.holdUntil, getLocale()), latest: longDay(view.notice.deadline, getLocale()) })}</p>
								{#if view.kind === 'revoked' && view.avertable}
									<p data-testid="api-erasure-avert">{t('apis.erasure_notice_avert')}</p>
								{:else if view.kind === 'reconnected' && view.avertable}
									<p data-testid="api-erasure-avert">{tf('apis.erasure_reconnected_avert', { who: view.who })}</p>
								{:else if view.kind === 'connectedAgain'}
									<p data-testid="api-erasure-avert">{t('apis.erasure_connected_again_avert')}</p>
								{/if}
							{/if}
							{#if viewLinks(view)}
								{#if profile.reader_may_connect !== false}
									<!-- A full page load: the engine's route answers with a page or a redirect to the provider. -->
									<a href={connectHref(getApiBase(), profile.id)} data-sveltekit-reload data-testid="api-reconnect"
										class="inline-block rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
								{:else if isOwnerSession()}
									<!-- The owner, on a profile a person with access set up: the line below the card says why. -->
								{:else}
									<!-- No link (U-109): to a mandate the server says `false` for a profile it did not
									     set up; the line says why. -->
									<p data-testid="api-reconnect-not-yours">{t('apis.reconnect_not_yours')}</p>
								{/if}
							{/if}
							{#if view.notice && view.kind !== 'pending'}
								{@const dates = { revoked: longDay(view.notice.revokedAt, getLocale()), earliest: longDay(view.notice.holdUntil, getLocale()), latest: longDay(view.notice.deadline, getLocale()) }}
								<details data-testid="api-erasure-details">
									<summary class="cursor-pointer text-text-subtle hover:text-text">{t('apis.erasure_details')}</summary>
									{#if view.kind === 'revoked'}
										<p class="mt-2" data-testid="api-erasure-notice">{tf('apis.erasure_notice', dates)} {t('apis.erasure_notice_tail')}</p>
									{:else if view.kind === 'reconnected'}
										<p class="mt-2" data-testid="api-erasure-reconnected">{tf('apis.erasure_reconnected_notice', { ...dates, who: view.who })}</p>
									{:else if view.kind === 'connectedAgain'}
										<p class="mt-2" data-testid="api-erasure-connected-again">{tf('apis.erasure_connected_again_notice', dates)}</p>
									{/if}
								</details>
							{/if}
						</div>
					{/if}
					<!-- A store's access end (U-391), as `accessLine` has it. -->
					{#if accessLine(profile)}
						{@const line = accessLine(profile)!}
						{@const access = line.access}
						<div class="border-t border-border px-4 py-3 space-y-2 text-xs text-text-muted" data-testid="api-access-ends">
							{#if access.kind === 'soon'}
								<p data-testid="api-access-ends-text">{isOwnerSession() ? `${tf('apis.access_ends_on', { date: access.date })} ${t('apis.access_ends_way')}` : tf('apis.access_ends_on', { date: access.date })}</p>
							{:else}
								<p data-testid="api-access-ended">{t('apis.access_ended')}</p>
							{/if}
							{#if !line.button}
								<!-- The revocation view above already offers the way. -->
							{:else if access.mayConnect}
								<a href={connectHref(getApiBase(), profile.id)} data-sveltekit-reload data-testid="api-reconnect"
									class="inline-block rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
							{:else if isOwnerSession()}
								<!-- The owner, on a profile a person with access set up: the line below says why. -->
							{:else}
								<p data-testid="api-reconnect-not-yours">{t('apis.reconnect_not_yours')}</p>
							{/if}
						</div>
					{/if}
					{#if isOwnerSession() && setUpByMember(profile) && profile.auth?.type === 'oauth2'}
						<!-- No connect for the owner on a profile a person with access set up: the view hides a
						     connection the owner makes there from every reader, the owner included, so it would show as
						     connected and carry nothing (`hiddenFromProfile`); the engine refuses the start too. The line
						     names the way, taking it over in the chat. The client pair can still be set for that person. -->
						<div class="border-t border-border px-4 py-3 space-y-2">
							<p class="text-xs text-text-muted" data-testid="api-set-up-by-member">{t('apis.set_up_by_member_owner')}</p>
							{#if onBuiltInProvider(profile)}<PresetClientForm profileId={profile.id} connectHref={null} />{/if}
						</div>
					{:else if onBuiltInProvider(profile) && isOwnerSession()}
						<div class="border-t border-border px-4 py-3">
							<PresetClientForm profileId={profile.id} connectHref={notYetConnected(profile) ? connectHref(getApiBase(), profile.id) : null} />
						</div>
					{:else if notYetConnected(profile) && profile.reader_client_withheld === false && profile.reader_may_connect !== false}
						<!-- The person who set it up, once the owner released the client pair to it: the first connect. -->
						<div class="border-t border-border px-4 py-3">
							<a href={connectHref(getApiBase(), profile.id)} data-sveltekit-reload data-testid="api-connect-first-member"
								class="inline-block rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">{t('apis.connect_first')}</a>
						</div>
					{:else if notYetConnected(profile) && profile.reader_client_withheld === true}
						<!-- The person who set it up, before the owner released the client pair: who has to act. -->
						<div class="border-t border-border px-4 py-3 text-xs text-text-muted">
							<p data-testid="api-connect-first-withheld">{t('apis.connect_first_client_withheld')}</p>
						</div>
					{:else if notYetConnected(profile) && profile.reader_may_connect === false}
						<!-- The server says `false` only to a mandate, which connects only a profile it set up. -->
						<div class="border-t border-border px-4 py-3 text-xs text-text-muted">
							<p data-testid="api-connect-first-not-yours">{t('apis.connect_first_not_yours')}</p>
						</div>
					{/if}
					<!-- The description is free text the profile was written with, a word or a sentence; under
					     its label in the opened card, whole and wrapped, not unlabelled in the head. One a person
					     with access wrote is set apart in the owner's view, the label stays lynox's words. -->
					{#if expanded === profile.id && profile.description}
						<div class="border-t border-border px-4 py-3">
							<p class="text-xs text-text-muted whitespace-normal break-words" data-testid="api-description" data-profile-description>{#if setUpByMember(profile)}<MarkedLine text={tf('apis.description', { text: shownWhole(profile.description) })} mono={false} />{:else}{tf('apis.description', { text: profile.description })}{/if}</p>
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
