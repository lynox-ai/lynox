<script lang="ts">
	import { t } from '$lib/i18n.svelte.js';
	import WhatsAppSettings from '$lib/components/WhatsAppSettings.svelte';
</script>

<div class="p-6 max-w-4xl mx-auto space-y-2">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<h1 class="text-xl font-light tracking-tight mt-2 mb-4">{t('settings.channels.whatsapp')}</h1>
</div>

<WhatsAppSettings />
