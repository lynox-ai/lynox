<!--
	Account → Security (Settings v3 PR 4 Item 12, 2026-05-19).

	Passkey enrolment / replacement entry point. Pre-PR-4, PasskeyPrompt.svelte
	was the ONLY way to register a passkey — surfaced as a one-time toast after
	first OTP login. If the user dismissed the toast there was no way back in.
	This page mirrors the PasskeyPrompt's `/auth/passkey` register/start +
	register/complete flow but exposes it as a permanent settings page.

	Tier-awareness audit:
	| Surface              | Self-host | BYOK | Managed |
	|----------------------|-----------|------|---------|
	| Passkey status       | ✗ no auth | ✗ no auth | ✓ shown |
	| Enrol / replace btn  | ✗ hidden  | ✗ hidden | ✓ button |

	(Self-host bypasses managed-auth entirely; passkey lives on the CP, not the
	engine. Cookie users on self-host are auto-promoted to admin scope.)
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { normalizeBillingTier } from '../utils/billing-tier.js';

	let managed = $state<boolean | null>(null);
	let hasPasskeys = $state<boolean | null>(null);
	let webauthnSupported = $state(true);
	let loaded = $state(false);
	let registering = $state(false);

	async function loadStatus(): Promise<void> {
		try {
			const cfg = await fetch(`${getApiBase()}/config`);
			if (cfg.ok) {
				const body = (await cfg.json()) as { managed?: string };
				// Any managed-infra tier (incl. Hosted-BYOK). normalizeBillingTier
				// maps legacy starter→hosted / eu→managed, so this covers both the
				// canonical ids the engine now emits and any un-re-synced legacy env.
				managed = !!normalizeBillingTier(body.managed);
			}

			if (typeof window === 'undefined' || !window.PublicKeyCredential) {
				webauthnSupported = false;
				loaded = true;
				return;
			}

			const res = await fetch('/auth/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'status' }),
			});
			if (res.ok) {
				const data = (await res.json()) as { hasPasskeys?: boolean; error?: string };
				if (!data.error) hasPasskeys = !!data.hasPasskeys;
			}
		} catch {
			// /auth/passkey unreachable means non-managed instance or proxy gap.
			// `loaded` still flips so we render the appropriate empty state.
		}
		loaded = true;
	}

	// Defensive JSON parser — the engine forwards /auth/passkey to the CP;
	// transient errors (CP unreachable, proxy gap) can surface as HTML 404/502
	// pages where .json() throws. Wrapping locally lets us emit the right
	// step-specific toast instead of the generic passkey_failed catch.
	async function readJson(res: Response): Promise<unknown> {
		try {
			return await res.json();
		} catch {
			return null;
		}
	}

	async function enrol(): Promise<void> {
		registering = true;
		try {
			const startRes = await fetch('/auth/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'register/start' }),
			});
			const options = await readJson(startRes);
			if (!startRes.ok || options === null) {
				addToast(t('account.security.passkey_start_failed'), 'error', 5000);
				return;
			}

			const { startRegistration } = await import('@simplewebauthn/browser');
			// CP returns canonical SimpleWebAuthn shape — cast is the contract
			// boundary; runtime validation would duplicate browser-side checks.
			const regResponse = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] });

			const ua = navigator.userAgent;
			const deviceName = /iPhone|iPad/.test(ua) ? 'iPhone/iPad'
				: /Mac/.test(ua) ? 'Mac'
				: /Android/.test(ua) ? 'Android'
				: /Windows/.test(ua) ? 'Windows'
				: 'Device';

			const verifyRes = await fetch('/auth/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'register/complete', response: regResponse, deviceName }),
			});
			const verifyData = await readJson(verifyRes) as { verified?: boolean; error?: string } | null;

			if (!verifyRes.ok || !verifyData?.verified) {
				addToast(verifyData?.error ?? t('account.security.passkey_failed'), 'error', 5000);
				return;
			}

			hasPasskeys = true;
			addToast(t('account.security.passkey_enrolled'), 'success', 4000);
		} catch (err: unknown) {
			// NotAllowedError = user cancelled the platform prompt — quiet.
			if (err instanceof Error && err.name === 'NotAllowedError') return;
			addToast(t('account.security.passkey_failed'), 'error', 5000);
		} finally {
			registering = false;
		}
	}

	$effect(() => { void loadStatus(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('account.security.title')}</h1>
		<p class="text-sm text-text-muted">{t('account.security.subtitle')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('account.security.loading')}</p>
	{:else if !managed}
		<!-- Self-host: passkey not applicable; engine cookie users are auto-admin. -->
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('account.security.self_host_note')}</p>
		</section>
	{:else if !webauthnSupported}
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('account.security.webauthn_unsupported')}</p>
		</section>
	{:else}
		<section class="space-y-4">
			<div class="rounded border border-border bg-bg-subtle p-4 flex items-start justify-between gap-4">
				<div>
					<div class="text-xs text-text-muted uppercase tracking-wider mb-1">{t('account.security.passkey_status')}</div>
					<div class="text-base font-medium">
						{hasPasskeys ? t('account.security.passkey_enrolled_label') : t('account.security.passkey_none_label')}
					</div>
					<p class="text-xs text-text-muted mt-1">
						{hasPasskeys ? t('account.security.passkey_enrolled_hint') : t('account.security.passkey_none_hint')}
					</p>
				</div>
				<button type="button" onclick={enrol} disabled={registering}
					class="shrink-0 px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50 transition-opacity">
					{registering
						? t('account.security.passkey_registering')
						: hasPasskeys
							? t('account.security.passkey_replace_cta')
							: t('account.security.passkey_enrol_cta')}
				</button>
			</div>
		</section>
	{/if}
</div>
