<!--
	Account → Billing (Settings v3 PR 4 Item 10, 2026-05-19).

	Surfaces the managed-tier subscription state + a link to the CP customer
	dashboard (control.lynox.cloud/checkout/account) where the user can open
	the Stripe Customer Portal, change card, download invoices, or cancel.

	Why not POST directly to /portal — the CP's POST /portal route is gated by
	customerAuth (CP-scoped session cookie). The engine UI runs on the
	tenant subdomain (e.g. `<sub>.lynox.cloud`) which doesn't share cookies
	with control.lynox.cloud. So we link to the CP page; the user authenticates
	with their existing customer session there and clicks the portal button.

	Tier-awareness audit:
	| Surface             | Self-host | BYOK | Managed |
	|---------------------|-----------|------|---------|
	| Subscription tier   | ✗ N/A     | ✗ N/A | ✓ shown |
	| Manage subscription | ✗ hidden  | ✗ hidden | ✓ button |
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	type ManagedTier = 'starter' | 'managed' | 'managed_pro' | 'eu';

	let managed = $state<ManagedTier | null>(null);
	let loaded = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { managed?: string };
			if (body.managed === 'starter' || body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu') {
				managed = body.managed;
			}
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('account.billing.load_failed'), 'error', 5000);
		}
	}

	$effect(() => { void load(); });

	const tierLabel = $derived.by(() => {
		// `managed===null` is filtered by the template before this derived
		// renders, so the four cases are exhaustive in practice. Keep a typed
		// switch with no default — TS narrows the union and a future tier id
		// addition (e.g. PRD-OPENAI-NATIVE `native` tier) will fail to compile.
		switch (managed) {
			case 'starter':      return t('account.billing.tier.hosted');
			case 'managed':      return t('account.billing.tier.managed');
			case 'managed_pro':  return t('account.billing.tier.managed_pro');
			case 'eu':           return t('account.billing.tier.managed');  // legacy alias
			case null:           return '—';
		}
	});

	const portalUrl = 'https://control.lynox.cloud/checkout/account';
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('account.billing.title')}</h1>
		<p class="text-sm text-text-muted">{t('account.billing.subtitle')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('account.billing.loading')}</p>
	{:else if managed === null}
		<!-- Self-host / BYOK with no LYNOX_MANAGED_MODE flag set — no
		     subscription to manage. Show an explanatory note instead of an
		     empty page (Item 8 show-all-grayed extends here too). -->
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('account.billing.self_host_note')}</p>
		</section>
	{:else}
		<section class="space-y-3">
			<div class="rounded border border-border bg-bg-subtle p-4">
				<div class="text-xs text-text-muted uppercase tracking-wider mb-1">{t('account.billing.current_tier')}</div>
				<div class="text-lg font-medium">{tierLabel}</div>
			</div>

			<p class="text-sm text-text-muted">{t('account.billing.portal_description')}</p>

			<!-- Link to the CP customer dashboard. Opens in new tab so the user
			     can return to the engine afterwards without losing context. -->
			<a href={portalUrl} target="_blank" rel="noopener"
				class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 transition-opacity">
				{t('account.billing.portal_cta')}
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
				</svg>
			</a>

			<p class="text-xs text-text-muted">{t('account.billing.portal_hint')}</p>
		</section>
	{/if}
</div>
