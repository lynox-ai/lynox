<script lang="ts">
	import { goto } from '$app/navigation';
	import { newChat } from '../stores/chat.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onMount, onDestroy } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import Icon from '../primitives/Icon.svelte';

	interface PaletteItem {
		id: string;
		label: string;
		group: string;
		action: () => void;
		keywords?: string;
		// PRD-IA-V2 P3-PR-I — mirror SettingsIndex.svelte:keepItem() so palette
		// hides tier-inappropriate routes. `selfHostOnly` is hidden on Managed,
		// `managedOnly` is hidden on Self-Host. Default-null probe (see below)
		// keeps both kinds hidden until /api/config confirms — same flash-free
		// pattern SettingsIndex uses.
		selfHostOnly?: boolean;
		managedOnly?: boolean;
	}

	let open = $state(false);
	let query = $state('');
	let selectedIdx = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	// `null` = not yet probed. We deliberately DO NOT default to `false` —
	// mirror of SettingsIndex.svelte:31 so the palette doesn't flash
	// tier-inappropriate entries during the ~300 ms before /api/config replies.
	let managed = $state<boolean | null>(null);

	$effect(() => {
		fetch(`${getApiBase()}/config`)
			.then(r => r.json())
			.then((data: Record<string, unknown>) => { managed = !!data['managed']; })
			.catch(() => { managed = false; });
	});

	const items: PaletteItem[] = [
		{ id: 'new-chat', label: t('cmd.new_chat'), group: t('cmd.actions'), action: () => { newChat(); goto('/app'); }, keywords: 'new chat neu' },
		{ id: 'nav-chat', label: t('nav.chat'), group: t('cmd.nav'), action: () => goto('/app'), keywords: 'chat home' },
		// PRD-IA-V2 P2-PR-E: Activity has its own root since P2-PR-A. Position
		// matches Desktop-Sidebar (after Chat/Inbox, before Hub) so palette
		// search aligns with the nav-rail. Inbox is feature-flag gated and
		// intentionally has no palette entry today — added when the flag GAs.
		{ id: 'nav-activity', label: t('nav.activity'), group: t('cmd.nav'), action: () => goto('/app/activity'), keywords: 'activity aktivität cost kosten history runs verbrauch usage' },
		{ id: 'nav-automation', label: t('nav.automation'), group: t('cmd.nav'), action: () => goto('/app/hub'), keywords: 'workflows pipelines automation dag abläufe tasks aufgaben hub' },
		{ id: 'nav-intelligence', label: t('nav.intelligence'), group: t('cmd.nav'), action: () => goto('/app/intelligence'), keywords: 'intelligence dashboards reports knowledge memory wissen graph insights kpi contacts kontakte crm' },
		{ id: 'nav-artifacts', label: t('nav.artifacts'), group: t('cmd.nav'), action: () => goto('/app/artifacts'), keywords: 'artifacts dashboards diagrams files galerie' },
		{ id: 'nav-settings', label: t('nav.settings'), group: t('cmd.nav'), action: () => goto('/app/settings'), keywords: 'settings einstellungen config' },
		// PRD-IA-V2 P1-PR-C — `/app/settings/keys` is now a 301 stub; SecretsView
		// (generic API-Key CRUD for Tavily/Brevo/custom) lives at `/llm/keys`,
		// the SSoT per PRD. Palette skips the redirect bounce and lands directly.
		{ id: 'nav-keys', label: t('settings.keys'), group: t('cmd.nav'), action: () => goto('/app/settings/llm/keys'), keywords: 'keys api schluessel' },
		// PRD-IA-V2 P3-PR-A2 — `settings.integrations` retired in favour of
		// `settings.channels`. Keywords still include the old "integrations"
		// term so muscle-memory queries still hit the right command.
		{ id: 'nav-channels', label: t('settings.channels'), group: t('cmd.nav'), action: () => goto('/app/settings/channels'), keywords: 'channels integrations google tavily mail email imap smtp whatsapp push notifications search' },
		// PRD-IA-V2 P1-PR-A2 — /app/settings/config was deleted; target the
		// LLM-page (Provider + Model + Advanced + Memory). Phase-3 splits this
		// further into /llm/advanced, /llm/memory, /workspace/limits, etc.
		{ id: 'nav-config', label: t('settings.config'), group: t('cmd.nav'), action: () => goto('/app/settings/llm'), keywords: 'config model effort thinking budget backup provider llm' },

		// PRD-IA-V2 P3-PR-C — LLM sub-pages split out from the LLMSettings root.
		// Reuse the existing `llm.subnav.*` keys (i18n.svelte.ts:339-344) — they
		// are the SSoT used in the LLM-page subnav tiles, so palette labels stay
		// in sync without dead-key duplication.
		{ id: 'nav-llm-advanced', label: t('llm.subnav.advanced.title'), group: t('cmd.nav'), action: () => goto('/app/settings/llm/advanced'), keywords: 'llm advanced erweitert effort thinking budget context window thoroughness gründlichkeit nachdenken kontextfenster experience erfahrung' },
		{ id: 'nav-llm-memory', label: t('llm.subnav.memory.title'), group: t('cmd.nav'), action: () => goto('/app/settings/llm/memory'), keywords: 'memory erinnerung learning lernen auto duration dauer agent-memory' },

		// PRD-IA-V2 P3-PR-A2 — Channel sub-routes (split from old
		// `/settings/integrations`). Reuse `settings.channels.*` keys to match
		// SettingsIndex tile labels.
		{ id: 'nav-channels-mail', label: t('settings.channels.mail'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/mail'), keywords: 'mail email e-mail imap smtp postfach inbox accounts konten app-passwort' },
		// Inbox-Regeln live under the mail-channel route. Reuse the existing
		// `inbox.rules_title` key (i18n.svelte.ts:1422) — it's the page-title
		// SSoT and works as a search-friendly palette label too.
		{ id: 'nav-channels-mail-rules', label: t('inbox.rules_title'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/mail/rules'), keywords: 'rules regeln inbox mail filter auto-archive newsletter' },
		{ id: 'nav-channels-whatsapp', label: t('settings.channels.whatsapp'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/whatsapp'), keywords: 'whatsapp wa business cloud api byok' },
		{ id: 'nav-channels-google', label: t('settings.channels.google'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/google'), keywords: 'google workspace gmail drive calendar sheets docs oauth' },
		{ id: 'nav-channels-notifications', label: t('settings.channels.notifications'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/notifications'), keywords: 'push notifications benachrichtigungen browser quiet hours ruhezeiten mute stumm' },
		{ id: 'nav-channels-search', label: t('settings.channels.search'), group: t('cmd.nav'), action: () => goto('/app/settings/channels/search'), keywords: 'search suche websuche tavily searxng' },

		// PRD-IA-V2 P3-PR-B — Workspace & System sub-pages (Self-Host only;
		// `keepItem()`-equivalent below filters these out on Managed). Reuses
		// `settings.workspace.*` keys — no new i18n needed.
		{ id: 'nav-workspace-backups', label: t('settings.workspace.backups'), group: t('cmd.nav'), action: () => goto('/app/settings/workspace/backups'), keywords: 'backups backup wiederherstellen restore schedule plan workspace system', selfHostOnly: true },
		{ id: 'nav-workspace-security', label: t('settings.workspace.security'), group: t('cmd.nav'), action: () => goto('/app/settings/workspace/security'), keywords: 'security sicherheit vault schlüssel key engine token access workspace system', selfHostOnly: true },
		{ id: 'nav-workspace-limits', label: t('settings.workspace.limits'), group: t('cmd.nav'), action: () => goto('/app/settings/workspace/limits'), keywords: 'limits caps spend ausgaben session day tag month monat http rate workspace system', selfHostOnly: true },
		{ id: 'nav-workspace-updates', label: t('settings.workspace.updates'), group: t('cmd.nav'), action: () => goto('/app/settings/workspace/updates'), keywords: 'updates versions versionen upgrade engine startup workspace system', selfHostOnly: true },
		// `/workspace/tools` and `/privacy/tools` mount the same ToolToggles
		// view (PRD-IA-V2 P3-PR-E both-routes-mount). Tier-gating ensures only
		// one shows up in the palette per instance — matches SettingsIndex.
		{ id: 'nav-workspace-tools', label: t('tools.heading'), group: t('cmd.nav'), action: () => goto('/app/settings/workspace/tools'), keywords: 'tools tool-berechtigungen permissions registry whitelist enable disable workspace system', selfHostOnly: true },

		// PRD-IA-V2 P3-PR-E — Privacy section. ToolToggles Managed-home (mirror
		// of `/workspace/tools` on Self-Host). `managedOnly` hides it on
		// Self-Host so the palette stays single-tier-clean.
		{ id: 'nav-privacy-tools', label: t('tools.heading'), group: t('cmd.nav'), action: () => goto('/app/settings/privacy/tools'), keywords: 'tools tool-berechtigungen permissions registry whitelist enable disable privacy datenschutz', managedOnly: true },
		// PRD-IA-V2 P3-PR-D — Voice settings moved under Privacy. Reuses
		// `voice.title` (i18n.svelte.ts:149) — SSoT for the page heading.
		{ id: 'nav-privacy-voice', label: t('voice.title'), group: t('cmd.nav'), action: () => goto('/app/settings/privacy/voice'), keywords: 'voice sprache stt tts speech text whisper mistral mikrofon mic' },

		// PRD-IA-V2 P3-PR-F — Mobile Access (QR-code PWA install) under Account.
		// SettingsIndex hides this on mobile/PWA via `hideOnMobile`, but the
		// palette is desktop-first (Cmd+K) so we surface it unconditionally —
		// a user on desktop searching "mobile" should always find it.
		{ id: 'nav-account-mobile', label: t('settings.account.mobile'), group: t('cmd.nav'), action: () => goto('/app/settings/account/mobile'), keywords: 'mobile pwa qr code install app phone telefon' },
	];

	// Mirror SettingsIndex.svelte:126-135 `keepItem()` — hide self-host-only
	// items on Managed (or while tier unknown), and managed-only items on
	// Self-Host (or while unknown). Default-null pattern ensures no flash.
	const hideSelfHostOnly = $derived(managed !== false);
	const hideManagedOnly = $derived(managed !== true);

	const visibleItems = $derived(items.filter((i) => {
		if (i.selfHostOnly && hideSelfHostOnly) return false;
		if (i.managedOnly && hideManagedOnly) return false;
		return true;
	}));

	const filtered = $derived(
		query.trim()
			? visibleItems.filter((item) => {
					const q = query.toLowerCase();
					return item.label.toLowerCase().includes(q) ||
						(item.keywords?.toLowerCase().includes(q) ?? false);
				})
			: visibleItems
	);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIdx = Math.max(selectedIdx - 1, 0);
		} else if (e.key === 'Enter' && filtered[selectedIdx]) {
			e.preventDefault();
			execute(filtered[selectedIdx]!);
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function execute(item: PaletteItem) {
		open = false;
		query = '';
		item.action();
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
			if (open) {
				query = '';
				selectedIdx = 0;
				requestAnimationFrame(() => inputEl?.focus());
			}
		}
	}

	onMount(() => {
		document.addEventListener('keydown', handleGlobalKeydown);
	});
	onDestroy(() => {
		document.removeEventListener('keydown', handleGlobalKeydown);
	});

	$effect(() => {
		if (filtered.length > 0 && selectedIdx >= filtered.length) {
			selectedIdx = 0;
		}
	});
</script>

{#if open}
	<!-- Backdrop -->
	<button class="fixed inset-0 z-50 bg-black/60" onclick={() => (open = false)} aria-label="Close"></button>

	<!-- Palette -->
	<div class="fixed inset-x-2 md:inset-x-4 z-50 mx-auto max-w-lg rounded-[var(--radius-lg)] border border-border bg-bg shadow-2xl overflow-hidden" style="top: calc(1rem + env(safe-area-inset-top, 0px));">
		<!-- Input -->
		<div class="flex items-center gap-3 border-b border-border px-4 py-3">
			<Icon name="search" size="sm" class="text-text-subtle" />
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={handleKeydown}
				placeholder={t('cmd.placeholder')}
				class="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
			/>
			<kbd class="text-[10px] font-mono text-text-subtle bg-bg-muted px-1.5 py-0.5 rounded">ESC</kbd>
		</div>

		<!-- Results -->
		<div class="max-h-72 overflow-y-auto py-2">
			{#if filtered.length === 0}
				<p class="px-4 py-3 text-sm text-text-subtle">{t('cmd.no_results')}</p>
			{:else}
				{@const groups = [...new Set(filtered.map((i) => i.group))]}
				{#each groups as group}
					<p class="px-4 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-text-subtle">{group}</p>
					{#each filtered.filter((i) => i.group === group) as item, i}
						{@const globalIdx = filtered.indexOf(item)}
						<button
							onclick={() => execute(item)}
							onmouseenter={() => (selectedIdx = globalIdx)}
							class="w-full px-4 py-2 text-sm text-left transition-colors
							{globalIdx === selectedIdx ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
						>
							{item.label}
						</button>
					{/each}
				{/each}
			{/if}
		</div>
	</div>
{/if}
