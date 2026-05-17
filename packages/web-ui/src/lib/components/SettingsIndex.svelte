<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface SettingsItem {
		href: string;
		titleKey: string;
		descKey: string;
		selfHostOnly?: boolean;
		// PRD-IA-V2 P3-PR-E — symmetric mirror of `selfHostOnly`. Default-null
		// pattern (see `managed = $state<boolean | null>(null)` below): hidden
		// while we don't yet know the tier. Used to route ToolToggles to its
		// Managed-home (`/settings/privacy/tools`) without an async redirect race.
		managedOnly?: boolean;
		hideOnMobile?: boolean;
	}

	interface SettingsSection {
		labelKey: string;
		items: SettingsItem[];
	}

	let { extraItems = [] }: { extraItems?: SettingsItem[] } = $props();

	// `null` = not yet probed. We deliberately DO NOT default to `false` —
	// on managed instances the /api/config round-trip would otherwise flash
	// the "Migration zu Managed Hosting" entry during the ~300 ms before the
	// response arrives, which is confusing for customers who already have a
	// managed instance. The filter below hides self-host-only items until we
	// have a confirmed answer (Rafael reported this on engine.lynox.cloud).
	let managed = $state<boolean | null>(null);

	// Same default-null pattern for mobile/PWA detection — on first paint we
	// don't yet know if we're in a standalone PWA or a narrow viewport, and
	// showing "Mobile Zugang" (QR code to install as PWA) on a phone that's
	// already running the PWA is nonsensical.
	let isMobileOrPwa = $state<boolean | null>(null);
	let engineVersion = $state<string | null>(null);

	$effect(() => {
		fetch(`${getApiBase()}/config`)
			.then(r => r.json())
			.then((data: Record<string, unknown>) => { managed = !!data['managed']; })
			.catch(() => { managed = false; });
	});

	$effect(() => {
		fetch(`${getApiBase()}/health`)
			.then(r => r.json())
			.then((data: Record<string, unknown>) => {
				if (typeof data['version'] === 'string' && data['version'].length > 0) {
					engineVersion = data['version'];
				}
			})
			.catch(() => { /* silent */ });
	});

	$effect(() => {
		if (typeof window === 'undefined') { isMobileOrPwa = false; return; }
		const narrowMq = window.matchMedia('(max-width: 767px)');
		const standaloneMq = window.matchMedia('(display-mode: standalone)');
		function update() {
			// iOS Safari exposes standalone as a non-standard navigator prop.
			const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
			isMobileOrPwa = standaloneMq.matches || iosStandalone || narrowMq.matches;
		}
		update();
		narrowMq.addEventListener('change', update);
		standaloneMq.addEventListener('change', update);
		return () => {
			narrowMq.removeEventListener('change', update);
			standaloneMq.removeEventListener('change', update);
		};
	});

	const sections: SettingsSection[] = [
		{
			labelKey: 'settings.section_main',
			items: [
				// PRD-IA-V2 P1-PR-A2 — /settings/config deleted; LLMSettings is the new
				// canonical entry-point for Provider + Model + Advanced + Memory.
				{ href: '/app/settings/llm', titleKey: 'settings.config', descKey: 'settings.config_desc' },
				// PRD-IA-V2 P3-PR-A2 — `/settings/integrations` retired in favour of
				// the new `/settings/channels` hub + per-channel sub-routes.
				{ href: '/app/settings/channels', titleKey: 'settings.channels', descKey: 'settings.channels_desc' },
			],
		},
		{
			// PRD-IA-V2 P3-PR-B: Workspace & System is Self-Host only — ToolToggles
			// moves under Privacy on Managed in P3-PR-E.
			labelKey: 'settings.section_workspace',
			items: [
				{ href: '/app/settings/workspace/backups', titleKey: 'settings.workspace.backups', descKey: 'settings.workspace.backups_desc', selfHostOnly: true },
				{ href: '/app/settings/workspace/security', titleKey: 'settings.workspace.security', descKey: 'settings.workspace.security_desc', selfHostOnly: true },
				{ href: '/app/settings/workspace/limits', titleKey: 'settings.workspace.limits', descKey: 'settings.workspace.limits_desc', selfHostOnly: true },
				{ href: '/app/settings/workspace/updates', titleKey: 'settings.workspace.updates', descKey: 'settings.workspace.updates_desc', selfHostOnly: true },
				{ href: '/app/settings/workspace/tools', titleKey: 'tools.heading', descKey: 'tools.subtitle', selfHostOnly: true },
			],
		},
		{
			// PRD-IA-V2 P3-PR-E — Privacy section. Currently hosts the Managed-home
			// Tool-Toggles tile (mirror of `/workspace/tools` on Self-Host). Both
			// routes mount `ToolToggles.svelte` and always 200 OK; `keepItem()`
			// hides the tier-inappropriate entry from the nav — no redirect race.
			labelKey: 'settings.section_privacy',
			items: [
				{ href: '/app/settings/privacy/tools', titleKey: 'tools.heading', descKey: 'tools.subtitle', managedOnly: true },
			],
		},
		{
			// PRD-IA-V2 P3-PR-F: Migration tile is self-host-only (Managed users skip the wizard).
			labelKey: 'settings.section_account',
			items: [
				{ href: '/app/settings/account/mobile', titleKey: 'settings.account.mobile', descKey: 'mobile.settings_desc', hideOnMobile: true },
				{ href: '/app/settings/account/migration', titleKey: 'settings.account.migration', descKey: 'migration.subtitle', selfHostOnly: true },
			],
		},
	];

	// Hide self-host-only items when managed is true OR still unknown.
	// Hide managed-only items when managed is false OR still unknown — symmetric
	// mirror of self-host-only (PRD-IA-V2 P3-PR-E). Both default to hidden until
	// the /api/config probe confirms the tier, so the user never sees a
	// tier-inappropriate flash during the ~300 ms before the response arrives.
	// Hide mobile-only items on PWA / narrow viewports (and while unknown).
	const hideSelfHostOnly = $derived(managed !== false);
	const hideManagedOnly = $derived(managed !== true);
	const hideMobileOnly = $derived(isMobileOrPwa !== false);

	function keepItem(i: SettingsItem): boolean {
		if (i.selfHostOnly && hideSelfHostOnly) return false;
		if (i.managedOnly && hideManagedOnly) return false;
		if (i.hideOnMobile && hideMobileOnly) return false;
		return true;
	}

	const finalSections = $derived(
		sections.map(section => ({
			labelKey: section.labelKey,
			items: section.items.filter(keepItem),
		})).concat(
			extraItems.length > 0
				? [{ labelKey: '', items: extraItems.filter(keepItem) }]
				: []
		).filter(s => s.items.length > 0)
	);

	const legalLinks = $derived([
		{
			href: `https://lynox.ai/${getLocale() === 'de' ? 'de/agb/' : 'terms'}`,
			label: t('legal.terms'),
		},
		{
			href: `https://lynox.ai/${getLocale() === 'de' ? 'de/datenschutz/' : 'privacy'}`,
			label: t('legal.privacy'),
		},
		{
			href: `https://lynox.ai/${getLocale() === 'de' ? 'de/avv/' : 'dpa'}`,
			label: t('legal.dpa'),
		},
		{
			href: `https://lynox.ai/${getLocale() === 'de' ? 'de/impressum/' : 'imprint'}`,
			label: t('legal.imprint'),
		},
	]);
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-6">{t('settings.title')}</h1>

	<div class="space-y-6">
		{#each finalSections as section}
			{#if section.labelKey}
				<div class="text-xs font-mono uppercase tracking-widest text-text-subtle border-b border-border pb-2">{t(section.labelKey)}</div>
			{/if}
			<div class="space-y-2">
				{#each section.items as item}
					<a
						href={item.href}
						class="block rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 hover:border-border-hover transition-colors"
					>
						<h2 class="font-medium">{t(item.titleKey)}</h2>
						<p class="text-sm text-text-muted mt-1">{t(item.descKey)}</p>
					</a>
				{/each}
			</div>
		{/each}
	</div>

	<footer class="mt-10 pt-6 border-t border-border text-[11px] text-text-subtle">
		{#if engineVersion}
			<div class="font-mono mb-3" title={t('status.engine_version')}>lynox v{engineVersion}</div>
		{/if}
		<div class="flex flex-wrap gap-x-3 gap-y-1">
			{#each legalLinks as link, i}
				{#if i > 0}<span class="text-border">·</span>{/if}
				<a href={link.href} target="_blank" rel="noopener" class="hover:text-text transition-colors">{link.label}</a>
			{/each}
		</div>
	</footer>
</div>
