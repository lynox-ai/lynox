<script lang="ts">
	// === Channels hub ===
	//
	// Landing page for `/app/settings/channels`. Replaces the old monolithic
	// `IntegrationsView.svelte` which dumped every channel onto one scroll.
	// Per PRD-IA-V2 P3-PR-A2, each channel now has its own sub-route and the
	// hub just lists them, mirroring how `SettingsIndex` works for the parent.

	import { t } from '../i18n.svelte.js';
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';

	interface ChannelItem {
		href: string;
		titleKey: string;
		descKey: string;
		// Managed-only blocks (e.g. SearXNG-on-managed is hidden because the
		// sidecar is pre-configured) — kept here for future tier-gating; today
		// none of the channels are tier-restricted at the top level.
		hideOnManaged?: boolean;
	}

	$effect(() => {
		void loadManagedStatus();
	});

	const channels: ChannelItem[] = [
		{ href: '/app/settings/channels/mail', titleKey: 'settings.channels.mail', descKey: 'settings.channels.mail_desc' },
		{ href: '/app/settings/channels/whatsapp', titleKey: 'settings.channels.whatsapp', descKey: 'settings.channels.whatsapp_desc' },
		{ href: '/app/settings/channels/google', titleKey: 'settings.channels.google', descKey: 'settings.channels.google_desc' },
		{ href: '/app/settings/channels/notifications', titleKey: 'settings.channels.notifications', descKey: 'settings.channels.notifications_desc' },
		{ href: '/app/settings/channels/search', titleKey: 'settings.channels.search', descKey: 'settings.channels.search_desc' },
	];

	const visibleChannels = $derived(channels.filter(c => !(c.hideOnManaged && isManaged())));
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('settings.channels')}</h1>

	<div class="space-y-2">
		{#each visibleChannels as channel}
			<a
				href={channel.href}
				class="block rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 hover:border-border-hover transition-colors"
			>
				<h2 class="font-medium">{t(channel.titleKey)}</h2>
				<p class="text-sm text-text-muted mt-1">{t(channel.descKey)}</p>
			</a>
		{/each}
	</div>
</div>
