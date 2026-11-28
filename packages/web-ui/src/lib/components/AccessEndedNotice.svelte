<!--
	What a person with delegated access sees once that access has ended: revoked by the owner, or
	past its end (engine 403 `mandate_revoked` / `mandate_ended`). Signing in again does not bring it
	back, so there is no button, only who to ask (U-306 B2). The text only: it stands in the shell's
	session banner, which gives it its surface.
-->
<script lang="ts">
	import { t } from '../i18n.svelte.js';
</script>

<div class="text-[12px] text-warning" data-state="access-ended">
	<strong>{t('session.access_ended_title')}</strong>
	<span class="ml-2 text-text-muted">{t('session.access_ended_text')}</span>
</div>
