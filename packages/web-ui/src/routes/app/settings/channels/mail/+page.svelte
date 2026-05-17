<script lang="ts">
	import { t } from '$lib/i18n.svelte.js';
	import MailSettings from '$lib/components/MailSettings.svelte';
</script>

<div class="p-6 max-w-4xl mx-auto space-y-2">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<div class="flex items-baseline justify-between mt-2 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('settings.channels.mail')}</h1>
		<a href="/app/settings/channels/mail/rules" class="text-xs text-accent-text hover:opacity-80 transition-opacity">
			{t('settings.channels.mail_rules_link')} &rarr;
		</a>
	</div>
</div>

<MailSettings />
