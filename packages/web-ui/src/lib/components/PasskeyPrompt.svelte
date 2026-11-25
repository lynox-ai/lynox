<!--
  Passkey setup hint — a quiet strip at the top of the chat column, in the flow (U-454): it never
  covers the composer or a work page's buttons. Shown on managed instances with WebAuthn, to the
  owner, while no passkey is registered and the hint was not dismissed.
-->
<script lang="ts">
	import { t } from '$lib/i18n.svelte.js';

	let visible = $state(false);
	let registering = $state(false);
	let error = $state<string | null>(null);
	let success = $state(false);

	$effect(() => {
		void checkShouldShow(); /* an unreachable control plane just shows no prompt */
	});

	async function checkShouldShow() {
		// Only show on managed instances with WebAuthn support
		if (typeof window === 'undefined') return;
		if (localStorage.getItem('lynox_passkey_dismissed')) return;
		if (!window.PublicKeyCredential) return;

		try {
			const res = await fetch('/auth/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'status' }),
			});

			if (!res.ok) return;
			const data = await res.json() as { hasPasskeys?: boolean; supported?: boolean; canRegister?: boolean; error?: string };

			// Only show if no passkeys registered yet
			if (data.error) return; // Not managed or unreachable
			// Self-host engines return `{supported: false}` for /auth/passkey because
			// the WebAuthn backend lives on the managed control plane, not the engine.
			// Without this guard the prompt shows up on self-host and clicking
			// "Set up" leads to a dead end (no /auth/passkey/register endpoint).
			if (data.supported === false) return;
			// Only the owner's own session may add a passkey (a mandate session may not).
			if (data.canRegister !== true) return;
			if (!data.hasPasskeys) {
				visible = true;
			}
		} catch {
			// Control plane unreachable — don't show prompt
		}
	}

	async function setupPasskey() {
		registering = true;
		error = null;

		try {
			// 1. Get registration options
			const startRes = await fetch('/auth/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'register/start' }),
			});

			if (!startRes.ok) {
				error = t('account.security.passkey_start_failed');
				return;
			}

			const options = await startRes.json();

			// 2. Prompt authenticator
			const { startRegistration } = await import('@simplewebauthn/browser');
			const regResponse = await startRegistration({ optionsJSON: options });

			// 3. Verify with control plane
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

			const verifyData = await verifyRes.json() as { verified?: boolean; error?: string };

			if (!verifyRes.ok || !verifyData.verified) {
				error = t('account.security.passkey_failed');
				return;
			}

			success = true;
			setTimeout(() => { visible = false; }, 3000);
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'NotAllowedError') {
				return; // User cancelled
			}
			error = t('account.security.passkey_failed');
		} finally {
			registering = false;
		}
	}

	function dismiss() {
		localStorage.setItem('lynox_passkey_dismissed', '1');
		visible = false;
	}
</script>

{#if visible}
	<div class="mx-4 mt-3 flex shrink-0 flex-col gap-2 rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2 sm:flex-row sm:items-center sm:justify-between md:mx-6" data-passkey-hint>
		{#if success}
			<p class="text-sm text-text" role="status">{t('passkeySetupSuccess')}</p>
		{:else}
			<div class="min-w-0">
				<p class="text-sm text-text">{t('passkeySetupHint')}</p>
				{#if error}
					<p class="mt-1 text-xs text-danger" role="alert">{error}</p>
				{/if}
			</div>
			<div class="flex shrink-0 gap-2">
				<button
					onclick={setupPasskey}
					disabled={registering}
					class="rounded-[var(--radius-md)] bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
					data-passkey-setup
				>
					{registering ? t('passkeySetupRegistering') : t('passkeySetupCta')}
				</button>
				<button
					onclick={dismiss}
					class="rounded-[var(--radius-md)] px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-muted hover:text-text"
					data-passkey-later
				>
					{t('passkeySetupDismiss')}
				</button>
			</div>
		{/if}
	</div>
{/if}
