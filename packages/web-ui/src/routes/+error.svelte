<script lang="ts">
	import { page } from '$app/stores';
	import { t } from '$lib/i18n.svelte.js';
</script>

<div class="flex h-screen items-center justify-center">
	<div class="text-center">
		<h1 class="text-4xl font-light text-text-muted mb-2">{$page.status}</h1>
		<p class="text-sm text-text-subtle">{$page.error?.message ?? t('error.fallback')}</p>
		<a href="/app" class="mt-4 inline-block text-sm text-accent-text hover:opacity-80">{t('common.back_to_chat')}</a>
	</div>
</div>
