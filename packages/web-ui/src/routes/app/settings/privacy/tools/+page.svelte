<script lang="ts">
	import ToolToggles from '$lib/components/ToolToggles.svelte';
	import { t } from '$lib/i18n.svelte.js';
</script>

<div class="px-6 pt-6 max-w-3xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
</div>

<ToolToggles />
