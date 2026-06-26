<script lang="ts">
	// IA reorg (M6): ToolToggles had two identical mounts differing only by
	// nav-section per tier (`/workspace/tools` Self-Host, `/privacy/tools`
	// Managed). Unified to this one all-tier route; both legacy paths 301 here.
	import ToolToggles from '$lib/components/ToolToggles.svelte';
	import { t } from '$lib/i18n.svelte.js';
</script>

<div class="px-6 pt-6 max-w-3xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
</div>

<ToolToggles />
