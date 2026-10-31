<!--
	Above a settings page in a mandate's session (ux U-104): the owner sets these, the mandate can
	see them and ask for a change. Always visible: no tooltip, no close button.
-->
<script lang="ts">
	import { t } from '../../i18n.svelte.js';
</script>

<p class="border border-border rounded p-3 text-sm text-text-muted" data-testid="owner-only-notice">
	{t('settings.owner_only_notice')}
</p>
