<script lang="ts">
	// === Push notifications channel card ===
	//
	// Extracted from IntegrationsView.svelte during PRD-IA-V2 P3-PR-A2.
	// Per-category opt-out + quiet hours + throttle + per-account mute live
	// in `stores/integrations/notifications.svelte.ts` (P3-PR-A1); the
	// Web-Push subscribe/unsubscribe flow lives in `stores/notifications.svelte.ts`.

	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import {
		initNotifications,
		enablePushNotifications,
		disablePushNotifications,
		testPushNotification,
		getNotificationPermission,
		isSubscribed,
		isLoading as isPushLoading,
		isSupported as isPushSupported,
		isIosWithoutPwa,
	} from '../stores/notifications.svelte.js';
	import {
		getPrefs,
		loadInboxPushPref,
		patchPrefs,
		patchThrottle,
		defaultBrowserTz,
	} from '../stores/integrations/notifications.svelte.js';

	$effect(() => {
		initNotifications();
		void loadInboxPushPref();
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('integrations.push_notifications')}</h1>

	{#if isIosWithoutPwa()}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.push_notifications')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.push_desc')}</p>
			</div>
			<span class="text-xs text-warning">{t('integrations.push_ios_hint_short')}</span>
		</div>
		<p class="text-xs text-text-muted">{t('integrations.push_ios_hint')}</p>
	</div>
	{:else if isPushSupported()}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.push_notifications')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.push_desc')}</p>
			</div>
			{#if isSubscribed()}
				<span class="text-xs text-success">{t('integrations.push_active')}</span>
			{:else if getNotificationPermission() === 'denied'}
				<span class="text-xs text-danger">{t('integrations.push_blocked')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.push_inactive')}</span>
			{/if}
		</div>

		{#if isSubscribed()}
			<div class="flex gap-2">
				<button
					onclick={async () => { const ok = await testPushNotification(); addToast(ok ? t('integrations.push_test_sent') : t('integrations.push_test_failed'), ok ? 'success' : 'error'); }}
					class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-base"
				>
					{t('integrations.push_test')}
				</button>
				<button
					onclick={async () => { await disablePushNotifications(); addToast(t('integrations.push_disabled'), 'info'); }}
					disabled={isPushLoading()}
					class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{t('integrations.push_disable')}
				</button>
			</div>
			<!-- Per-category opt-out + Quiet Hours + throttle + per-account
				mute. All keys live in the same envelope and are PATCHed
				deltas; backend defaults missing fields. -->
			{#if getPrefs()}
			{@const prefs = getPrefs()!}
			<div class="mt-4 space-y-3 border-t border-border pt-3">
				<label class="flex items-start gap-2 cursor-pointer text-sm">
					<input
						type="checkbox"
						checked={prefs.inboxPushEnabled}
						onchange={(e) => void patchPrefs({ inboxPushEnabled: (e.currentTarget as HTMLInputElement).checked })}
						class="mt-0.5"
					/>
					<span>
						<span class="text-text">{t('integrations.push_inbox_toggle')}</span>
						<span class="block text-xs text-text-muted">{t('integrations.push_inbox_toggle_hint')}</span>
					</span>
				</label>

				<!-- Quiet Hours -->
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3">
					<label class="flex items-start gap-2 cursor-pointer text-sm">
						<input
							type="checkbox"
							checked={prefs.quietHours.enabled}
							onchange={(e) => void patchPrefs({ quietHours: {
								enabled: (e.currentTarget as HTMLInputElement).checked,
								// Backfill the user's TZ on first enable so a server
								// without LYNOX_TZ doesn't silently mute everything in UTC.
								...(prefs.quietHours.tz === 'UTC' ? { tz: defaultBrowserTz() } : {}),
							} })}
							class="mt-0.5"
						/>
						<span>
							<span class="text-text">{t('integrations.push_quiet_hours_toggle')}</span>
							<span class="block text-xs text-text-muted">{t('integrations.push_quiet_hours_hint')}</span>
						</span>
					</label>
					{#if prefs.quietHours.enabled}
						<div class="mt-2 flex items-center gap-2 text-xs text-text-muted pl-6">
							<label class="flex items-center gap-1">
								{t('integrations.push_quiet_hours_from')}
								<input
									type="time"
									value={prefs.quietHours.start}
									onchange={(e) => void patchPrefs({ quietHours: { start: (e.currentTarget as HTMLInputElement).value } })}
									class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
								/>
							</label>
							<label class="flex items-center gap-1">
								{t('integrations.push_quiet_hours_to')}
								<input
									type="time"
									value={prefs.quietHours.end}
									onchange={(e) => void patchPrefs({ quietHours: { end: (e.currentTarget as HTMLInputElement).value } })}
									class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
								/>
							</label>
							<span class="text-text-subtle">({prefs.quietHours.tz})</span>
						</div>
					{/if}
				</div>

				<!-- Throttle -->
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3 text-sm">
					<div class="text-text mb-2">{t('integrations.push_throttle_title')}</div>
					<div class="flex items-center gap-3 text-xs text-text-muted">
						<label class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="10"
								value={prefs.perMinute}
								onchange={(e) => patchThrottle('perMinute', (e.currentTarget as HTMLInputElement).value)}
								class="w-16 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
							/>
							{t('integrations.push_throttle_per_minute')}
						</label>
						<label class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="60"
								value={prefs.perHour}
								onchange={(e) => patchThrottle('perHour', (e.currentTarget as HTMLInputElement).value)}
								class="w-16 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
							/>
							{t('integrations.push_throttle_per_hour')}
						</label>
					</div>
				</div>

				<!-- Per-account mute -->
				{#if prefs.accounts.length > 1}
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3 text-sm">
					<div class="text-text mb-2">{t('integrations.push_per_account_title')}</div>
					<div class="space-y-1.5">
						{#each prefs.accounts as acct (acct.id)}
							<label class="flex items-center gap-2 text-xs cursor-pointer">
								<input
									type="checkbox"
									checked={!acct.muted}
									onchange={(e) => void patchPrefs({ accounts: { [acct.id]: !(e.currentTarget as HTMLInputElement).checked } })}
								/>
								<span class="text-text">{acct.displayName}</span>
								<span class="text-text-subtle">&lt;{acct.address}&gt;</span>
							</label>
						{/each}
					</div>
				</div>
				{/if}
			</div>
			{/if}
		{:else if getNotificationPermission() === 'denied'}
			<p class="text-xs text-text-muted">{t('integrations.push_denied_hint')}</p>
		{:else}
			<button
				onclick={async () => { const ok = await enablePushNotifications(); addToast(ok ? t('integrations.push_enabled') : t('integrations.push_enable_failed'), ok ? 'success' : 'error'); }}
				disabled={isPushLoading()}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
			>
				{isPushLoading() ? t('common.loading') : t('integrations.push_enable')}
			</button>
		{/if}
	</div>
	{:else}
	<!--
		Browser doesn't support Web Push and we're not on iOS-without-PWA.
		Original IntegrationsView rendered nothing in this branch — preserve
		that to keep zero-behaviour-change semantics.
	-->
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-2">
			<div>
				<h2 class="font-medium">{t('integrations.push_notifications')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.push_desc')}</p>
			</div>
			<span class="text-xs text-text-subtle">{t('integrations.push_unavailable')}</span>
		</div>
	</div>
	{/if}
</div>
