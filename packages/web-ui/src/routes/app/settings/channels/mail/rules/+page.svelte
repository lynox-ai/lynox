<script lang="ts">
	// PRD-IA-V2 P3-PR-A2 + PRD-UNIFIED-INBOX.md Phase 4 — canonical home for
	// the inbox-rules UI is now `/app/settings/channels/mail/rules`. The
	// component is also mounted at `/app/inbox/rules` (in-inbox shortcut),
	// and the legacy `/app/settings/integrations/mail/rules` path 301-redirects
	// here.
	import RulesView from '$lib/components/RulesView.svelte';
</script>

<RulesView />
