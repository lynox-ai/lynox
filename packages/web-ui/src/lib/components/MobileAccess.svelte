<script lang="ts">
	import { encode } from 'uqr';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { invalidateAll } from '$app/navigation';

	let { hasSecret = false, linkCode = '' }: { hasSecret: boolean; linkCode: string } = $props();

	let expired = $state(false);

	const loginUrl = $derived(
		linkCode && !expired && typeof window !== 'undefined'
			? `${window.location.origin}/login?code=${encodeURIComponent(linkCode)}`
			: ''
	);

	const qrMatrix = $derived(loginUrl ? encode(loginUrl, { ecc: 'M', border: 2 }) : null);

	// Silent expiration after 5 minutes
	$effect(() => {
		if (!linkCode) return;
		expired = false;
		const timer = setTimeout(() => { expired = true; }, 5 * 60 * 1000);
		return () => clearTimeout(timer);
	});

	async function refresh() {
		await invalidateAll();
	}

	function copyUrl() {
		if (loginUrl) {
			navigator.clipboard.writeText(loginUrl);
			addToast(t('common.copied'), 'success', 1500);
		}
	}
</script>

<div class="p-6 max-w-lg mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-2 mt-2">{t('mobile.title')}</h1>
	<p class="text-sm text-text-muted mb-6">{t('mobile.desc')}</p>

	{#if !hasSecret}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5 text-sm text-text-muted">
			{t('mobile.no_secret')}
		</div>
	{:else if expired}
		<div class="flex flex-col items-center gap-4 py-12">
			<p class="text-sm text-text-muted">{t('mobile.expired')}</p>
			<button
				onclick={refresh}
				class="rounded-[var(--radius-md)] bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
			>
				{t('mobile.new_code')}
			</button>
		</div>
	{:else}
		<div class="flex flex-col items-center gap-5">
			<!-- QR Code -->
			{#if qrMatrix}
				<div class="rounded-[var(--radius-lg)] bg-white p-5 shadow-lg">
					<svg
						viewBox="0 0 {qrMatrix.size} {qrMatrix.size}"
						class="w-60 h-60"
						shape-rendering="crispEdges"
					>
						{#each { length: qrMatrix.size } as _, y}
							{#each { length: qrMatrix.size } as _, x}
								{#if qrMatrix.data[y]?.[x]}
									<rect {x} {y} width="1" height="1" fill="#1a1a2e" />
								{/if}
							{/each}
						{/each}
					</svg>
				</div>
			{/if}

			<!-- Steps -->
			<div class="w-full space-y-3 text-sm">
				<div class="flex items-start gap-3">
					<span class="flex items-center justify-center h-6 w-6 rounded-full bg-accent/15 text-accent text-xs font-bold shrink-0">1</span>
					<p class="text-text-muted pt-0.5">{t('mobile.step1')}</p>
				</div>
				<div class="flex items-start gap-3">
					<span class="flex items-center justify-center h-6 w-6 rounded-full bg-accent/15 text-accent text-xs font-bold shrink-0">2</span>
					<div class="pt-0.5">
						<p class="text-text-muted">{t('mobile.step2')}</p>
						<p class="text-xs text-text-subtle mt-1">
							<span class="font-medium">iOS:</span> {t('mobile.pwa_ios')}
							<span class="mx-1.5 text-border">|</span>
							<span class="font-medium">Android:</span> {t('mobile.pwa_android')}
						</p>
					</div>
				</div>
			</div>

			<!-- Fallback: copyable URL -->
			<details class="w-full text-xs">
				<summary class="cursor-pointer text-text-subtle hover:text-text-muted transition-colors">
					{t('mobile.fallback')}
				</summary>
				<div class="mt-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3">
					<p class="font-mono text-[11px] truncate min-w-0 flex-1 select-all">{loginUrl}</p>
					<button
						onclick={copyUrl}
						class="shrink-0 rounded-[var(--radius-sm)] border border-border px-2.5 py-1 hover:bg-bg-muted transition-colors"
					>
						{t('common.copy')}
					</button>
				</div>
				<p class="mt-1.5 text-text-subtle">{t('mobile.fallback_hint')}</p>
			</details>
		</div>
	{/if}
</div>
