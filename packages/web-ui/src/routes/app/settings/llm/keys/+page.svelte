<script lang="ts">
	// IA reorg (D2): 3rd-party API keys are low-frequency config, so their home
	// is Settings (not the Automation Hub). The hub's `?section=keys` now 301s
	// here (see routes/app/hub/+page.ts). SecretsView owns its own padding + fetch.
	import SecretsView from '$lib/components/SecretsView.svelte';
</script>

<SecretsView />
