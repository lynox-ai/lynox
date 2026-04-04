<script lang="ts">
	import { t } from '../i18n.svelte.js';

	interface SettingsItem {
		href: string;
		titleKey: string;
		descKey: string;
	}

	let { extraItems = [] }: { extraItems?: SettingsItem[] } = $props();

	const baseItems: SettingsItem[] = [
		{ href: '/app/settings/mobile', titleKey: 'mobile.title', descKey: 'mobile.settings_desc' },
		{ href: '/app/settings/config', titleKey: 'settings.config', descKey: 'settings.config_desc' },
		{ href: '/app/settings/keys', titleKey: 'keys.title', descKey: 'keys.settings_desc' },
		{ href: '/app/settings/integrations', titleKey: 'settings.integrations', descKey: 'settings.integrations_desc' },
		{ href: '/app/settings/apis', titleKey: 'apis.title', descKey: 'apis.no_profiles' },
		{ href: '/app/settings/data', titleKey: 'data.title', descKey: 'data.no_collections' },
		{ href: '/app/settings/backups', titleKey: 'backups.title', descKey: 'backups.desc' },
	];

	const items = $derived([...baseItems, ...extraItems]);
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('settings.title')}</h1>

	<div class="space-y-2">
		{#each items as item}
			<a
				href={item.href}
				class="block rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 hover:border-border-hover transition-colors"
			>
				<h2 class="font-medium">{t(item.titleKey)}</h2>
				<p class="text-sm text-text-muted mt-1">{t(item.descKey)}</p>
			</a>
		{/each}
	</div>
</div>
