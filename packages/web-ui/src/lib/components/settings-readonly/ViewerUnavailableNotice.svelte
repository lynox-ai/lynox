<!--
	Above a page whose owner actions wait for whose session it is (ux U-117): shown once, and only
	when the first request and every retry went unanswered, so the owner is not left without the
	actions and without a reason. Not while waiting, and not after an answer.
-->
<script lang="ts">
	import { t } from '../../i18n.svelte.js';
	import { isViewerUnavailable } from '../../stores/settings-viewer.svelte.js';
</script>

{#if isViewerUnavailable()}
	<p class="mb-4 border border-warning/30 bg-warning/10 rounded p-3 text-sm text-warning" role="status" data-testid="viewer-unavailable">
		{t('settings.viewer_unavailable')}
	</p>
{/if}
