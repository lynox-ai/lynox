<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface SettingsItem {
		href: string;
		titleKey: string;
		descKey: string;
		selfHostOnly?: boolean;
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
				{ href: '/app/settings/config', titleKey: 'settings.config', descKey: 'settings.config_desc' },
				{ href: '/app/settings/integrations', titleKey: 'settings.integrations', descKey: 'settings.integrations_desc' },
			],
		},
		{
			labelKey: 'settings.section_data',
			items: [
				{ href: '/app/settings/apis', titleKey: 'apis.title', descKey: 'apis.no_profiles' },
				{ href: '/app/settings/data', titleKey: 'data.title', descKey: 'data.no_collections' },
				{ href: '/app/settings/backups', titleKey: 'backups.title', descKey: 'backups.desc' },
			],
		},
		{
			labelKey: 'settings.section_access',
			items: [
				{ href: '/app/settings/mobile', titleKey: 'mobile.title', descKey: 'mobile.settings_desc', hideOnMobile: true },
				{ href: '/app/settings/tasks', titleKey: 'settings.tasks', descKey: 'settings.tasks' },
				{ href: '/app/migration', titleKey: 'migration.title', descKey: 'migration.subtitle', selfHostOnly: true },
			],
		},
	];

	// Hide self-host-only items when managed is true OR still unknown.
	// Hide mobile-only items on PWA / narrow viewports (and while unknown).
	const hideSelfHostOnly = $derived(managed !== false);
	const hideMobileOnly = $derived(isMobileOrPwa !== false);

	function keepItem(i: SettingsItem): boolean {
		if (i.selfHostOnly && hideSelfHostOnly) return false;
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
