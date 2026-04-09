<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface SettingsItem {
		href: string;
		titleKey: string;
		descKey: string;
		selfHostOnly?: boolean;
	}

	interface SettingsSection {
		labelKey: string;
		items: SettingsItem[];
	}

	let { extraItems = [] }: { extraItems?: SettingsItem[] } = $props();

	let managed = $state(false);

	$effect(() => {
		fetch(`${getApiBase()}/config`)
			.then(r => r.json())
			.then((data: Record<string, unknown>) => { managed = !!data['managed']; })
			.catch(() => {});
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
				{ href: '/app/settings/mobile', titleKey: 'mobile.title', descKey: 'mobile.settings_desc' },
				{ href: '/app/settings/tasks', titleKey: 'settings.tasks', descKey: 'settings.tasks' },
				{ href: '/app/migration', titleKey: 'migration.title', descKey: 'migration.subtitle', selfHostOnly: true },
			],
		},
	];

	const finalSections = $derived(
		sections.map(section => ({
			labelKey: section.labelKey,
			items: section.items.filter(i => !i.selfHostOnly || !managed),
		})).concat(
			extraItems.length > 0
				? [{ labelKey: '', items: extraItems.filter(i => !i.selfHostOnly || !managed) }]
				: []
		).filter(s => s.items.length > 0)
	);
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
</div>
