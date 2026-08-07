<script lang="ts">
	// === Channels hub ===
	//
	// Landing page for `/app/settings/channels`. Replaces the old monolithic
	// `IntegrationsView.svelte` which dumped every channel onto one scroll.
	// Per PRD-IA-V2 P3-PR-A2, each channel now has its own sub-route and the
	// hub just lists them, mirroring how `SettingsIndex` works for the parent.

	import { t } from '../i18n.svelte.js';
	import { getApiBase } from '../config.svelte.js';

	interface ChannelItem {
		href: string;
		titleKey: string;
		descKey: string;
	}

	// The probe is back, and the calendar is why. It ships with `calendar_enabled` off wherever the
	// control plane has not turned it on — which is every tenant today, but that state lives in
	// the CP database, not here. So the tile follows the PROBE rather than an assumption — but the tile linked to a settings page that
	// happily takes the operator's ICS address, stores it in the vault and reports success, for
	// a tool that will never read it. A channel offering a credential nothing consumes is worse
	// than a missing channel. Same shape as IntelligenceHub's tab gating; costs one RTT on mount.
	let hasCalendar = $state(false);
	$effect(() => {
		void (async () => {
			try {
				const res = await fetch(`${getApiBase()}/config`);
				if (!res.ok) return;
				const body = (await res.json()) as { capabilities?: { has_calendar?: boolean } };
				hasCalendar = body.capabilities?.has_calendar === true;
			} catch { /* leave the tile hidden on probe failure — fail closed */ }
		})();
	});

	const CALENDAR_HREF = '/app/settings/channels/calendar';
	const channels: ChannelItem[] = [
		{ href: '/app/settings/channels/mail', titleKey: 'settings.channels.mail', descKey: 'settings.channels.mail_desc' },
		{ href: '/app/settings/channels/google', titleKey: 'settings.channels.google', descKey: 'settings.channels.google_desc' },
		{ href: '/app/settings/channels/notifications', titleKey: 'settings.channels.notifications', descKey: 'settings.channels.notifications_desc' },
		{ href: '/app/settings/channels/search', titleKey: 'settings.channels.search', descKey: 'settings.channels.search_desc' },
		{ href: CALENDAR_HREF, titleKey: 'settings.channels.calendar', descKey: 'settings.channels.calendar_desc' },
	];
	const visibleChannels = $derived(channels.filter((c) => c.href !== CALENDAR_HREF || hasCalendar));
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
