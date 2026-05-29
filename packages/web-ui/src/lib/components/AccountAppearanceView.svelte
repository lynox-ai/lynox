<!--
	Account → Appearance — Light/Dark/System theme preference.

	v1 = theme only. Future: font-size, density, sidebar-width.
	All-tier: visible on self-host AND managed. No tier-gating.
-->
<script lang="ts">
	import ThemeToggle from './ThemeToggle.svelte';
	import { t } from '../i18n.svelte.js';
	import { isDiagnosticsEnabled, toggleDiagnostics } from '../stores/diagnostics.svelte.js';
</script>

<div class="p-6 max-w-3xl mx-auto space-y-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6">{t('appearance.heading')}</h1>

	<section class="space-y-4">
		<div>
			<div class="text-sm font-medium mb-1">{t('theme.heading')}</div>
			<p class="text-sm text-text-muted mb-3">{t('theme.subtitle')}</p>
			<ThemeToggle />
		</div>

		<div class="pt-4 border-t border-border">
			<div class="flex items-center justify-between gap-4">
				<div>
					<div class="text-sm font-medium mb-1">{t('diagnostics.heading')}</div>
					<p class="text-sm text-text-muted">{t('diagnostics.subtitle')}</p>
				</div>
				<button
					role="switch"
					aria-checked={isDiagnosticsEnabled()}
					aria-label={t('diagnostics.heading')}
					onclick={() => toggleDiagnostics()}
					class="relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors {isDiagnosticsEnabled() ? 'bg-accent' : 'bg-bg-muted border border-border'}"
				>
					<span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {isDiagnosticsEnabled() ? 'translate-x-6' : 'translate-x-1'}"></span>
				</button>
			</div>
		</div>

		<div class="text-xs text-text-subtle pt-2 border-t border-border">
			{t('appearance.system_hint')}
		</div>
	</section>
</div>
