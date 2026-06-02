<!--
	Account → Billing (Settings v3 PR 4 Item 10, originally 2026-05-19;
	stopgap UX revision for v1.6.0, also 2026-05-19).

	V1 shipped a CTA pointing at `control.lynox.cloud/checkout/account` —
	broken in practice because the CP route is cookie-gated (`customerAuth`)
	and tenant-subdomain browsers don't share cookies with control.lynox.cloud.
	Customer saw raw `{"error":"Authentication required..."}` JSON instead of
	a portal. Captured during a canary verify on a pilot instance.

	V1.6.0 stopgap (this revision): if the engine has `LYNOX_STRIPE_PORTAL_LOGIN_URL`
	env set (= Stripe-hosted Customer-Portal login page, `billing.stripe.com/p/login/...`),
	render that as the primary CTA. Customer enters their email there, Stripe
	sends a magic link, customer lands in their own Stripe portal with every
	feature (cancel, change plan, update PM, invoices). Zero infrastructure
	on our side — Stripe handles auth + portal.

	If the env is unset (older / unconfigured instance), the CTA disappears
	entirely and only the support@ fallback shows. No more broken JSON 401.

	Full engine→CP→Stripe SSO (1-click instead of 2-click) deferred to
	[[project_pr3_stripe_portal_sso_deferred]] — PRD-v3 at
	`pro/docs/internal/PRD-STRIPE-PORTAL-SSO.md` is the spec for that sprint.

	Tier-awareness audit (`managed` value from /api/config, canonical post-v1.8.0):
	| Surface             | null (self-host)      | 'hosted'/'managed'/'managed_pro' |
	|---------------------|-----------------------|----------------------------------------|
	| Subscription tier   | ✗ self_host_note      | ✓ tier label                           |
	| Stripe portal CTA   | ✗ hidden              | ✓ if LYNOX_STRIPE_PORTAL_LOGIN_URL set |
	| Support fallback    | ✗ hidden              | ✓ always rendered                      |
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { normalizeBillingTier, isHostedInstance, type BillingTier } from '../utils/billing-tier.js';

	let managed = $state<BillingTier | null>(null);
	let stripePortalUrl = $state<string | null>(null);
	let loaded = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { managed?: string; stripe_portal_login_url?: string };
			// normalizeBillingTier maps any legacy id (starter→hosted, eu→managed)
			// to canonical; the engine already emits canonical, this stays robust.
			const norm = normalizeBillingTier(body.managed);
			if (norm) managed = norm;
			// Stripe-hosted login URL — engine only surfaces it when it passes
			// the `^https://billing.stripe.com/` prefix check, so we trust the
			// shape here and just render. Absent → CTA hidden, support fallback only.
			if (typeof body.stripe_portal_login_url === 'string') {
				stripePortalUrl = body.stripe_portal_login_url;
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
			case 'hosted':       return t('account.billing.tier.hosted');
			case 'managed':      return t('account.billing.tier.managed');
			case 'managed_pro':  return t('account.billing.tier.managed_pro');
			case null:           return '—';
		}
	});

	const supportEmail = 'support@lynox.ai';
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('account.billing.title')}</h1>
		<!-- Subtitle is conditional: the "Verwalte … via Stripe Customer Portal"
		     copy is only honest when a portal URL is actually wired. For
		     Hosted-BYOK demo tenants without LYNOX_STRIPE_PORTAL_LOGIN_URL set,
		     fall back to a neutral "Plan-Status und Support-Kontakt" line so
		     we don't promise something the page can't deliver. Found 2026-05-27
		     during meridian-demo HN-readiness walk. -->
		<p class="text-sm text-text-muted">
			{stripePortalUrl ? t('account.billing.subtitle') : t('account.billing.subtitle_no_portal')}
		</p>
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

			{#if stripePortalUrl}
				<!-- Stripe-hosted Customer-Portal login. Customer enters email
				     on Stripe's page, gets magic-link to portal. New tab so
				     the engine settings stay open in the original tab. -->
				<p class="text-sm text-text-muted">{t('account.billing.portal_description')}</p>
				<a href={stripePortalUrl} target="_blank" rel="noopener"
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 transition-opacity">
					{t('account.billing.portal_cta')}
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
					</svg>
				</a>
				<p class="text-xs text-text-muted">{t('account.billing.portal_hint')}</p>
			{/if}

			{#if isHostedInstance(managed)}
				<!-- Hosted-BYOK customers get a soft upgrade-CTA — without it
				     the page has no self-serve path from CHF 39 BYOK to
				     CHF 79/149 Managed plans, and the visitor sees a billing
				     page with only a tier-label + mailto. Mailto stopgap until
				     [[project_pr3_stripe_portal_sso_deferred]] lands a proper
				     in-portal plan-switch flow. -->
				<div class="rounded border border-border bg-bg-subtle p-4 text-sm space-y-2">
					<p class="font-medium text-text">{t('account.billing.upgrade_heading')}</p>
					<p class="text-text-muted">{t('account.billing.upgrade_body')}</p>
					<a href="mailto:{supportEmail}?subject=Upgrade%20to%20Managed&body=Hi%2C%20I%27d%20like%20to%20upgrade%20my%20Hosted-BYOK%20subscription%20to%20Managed%20%2F%20Managed%20Pro.%20Please%20set%20up%20the%20switch.%20Thanks."
						class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 transition-opacity">
						{t('account.billing.upgrade_cta')}
					</a>
				</div>
			{/if}

			<!-- Always-visible support fallback — covers (a) instances without
			     LYNOX_STRIPE_PORTAL_LOGIN_URL configured yet, (b) edge cases
			     the Stripe portal doesn't handle (refunds, mid-cycle plan
			     swaps, billing-address corrections). Stripe portal handles
			     cancel + PM update + most plan changes self-serve. -->
			<div class="rounded border border-border p-4 text-sm text-text-muted space-y-2">
				<p class="font-medium text-text">{t('account.billing.support_heading')}</p>
				<p>
					{t('account.billing.support_body')}
					<a href="mailto:{supportEmail}?subject=Abo%20%26%20Rechnung"
					   class="text-accent hover:underline">{supportEmail}</a>
				</p>
			</div>
		</section>
	{/if}
</div>
