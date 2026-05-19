<!--
	Account → Appearance — Light/Dark/System theme preference.

	v1 = theme only. Future: font-size, density, sidebar-width.
	All-tier: visible on self-host AND managed. No tier-gating.
-->
<script lang="ts">
	import ThemeToggle from './ThemeToggle.svelte';
	import { t } from '../i18n.svelte.js';
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

		<div class="text-xs text-text-subtle pt-2 border-t border-border">
			{t('appearance.system_hint')}
		</div>
	</section>
</div>
