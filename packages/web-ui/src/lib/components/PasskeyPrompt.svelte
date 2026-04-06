<!--
  Passkey setup prompt — shown after first OTP login on managed instances.
  Conditions: managed mode, WebAuthn available, no passkey registered, not dismissed.
-->
<script lang="ts">
	import { t } from '$lib/i18n.svelte.js';

	let visible = $state(false);
	let registering = $state(false);
	let error = $state<string | null>(null);
	let success = $state(false);

	$effect(() => {
		checkShouldShow();
	});

	async function checkShouldShow() {
		// Only show on managed instances with WebAuthn support
		if (typeof window === 'undefined') return;
		if (localStorage.getItem('lynox_passkey_dismissed')) return;
		if (!window.PublicKeyCredential) return;

		try {
			const res = await fetch('/api/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'status' }),
			});

			if (!res.ok) return;
			const data = await res.json() as { hasPasskeys?: boolean; error?: string };

			// Only show if no passkeys registered yet
			if (data.error) return; // Not managed or unreachable
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
			const startRes = await fetch('/api/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'register/start' }),
			});

			if (!startRes.ok) {
				error = 'Could not start registration.';
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

			const verifyRes = await fetch('/api/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'register/complete', response: regResponse, deviceName }),
			});

			const verifyData = await verifyRes.json() as { verified?: boolean; error?: string };

			if (!verifyRes.ok || !verifyData.verified) {
				error = verifyData.error ?? 'Registration failed.';
				return;
			}

			success = true;
			setTimeout(() => { visible = false; }, 3000);
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'NotAllowedError') {
				return; // User cancelled
			}
			error = 'Registration failed. Please try again.';
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
	<div class="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border bg-bg-raised p-4 shadow-lg">
		{#if success}
			<div class="flex items-center gap-3">
				<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-400">
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
					</svg>
				</div>
				<p class="text-sm text-text">
					{t('passkeySetupSuccess')}
				</p>
			</div>
		{:else}
			<div class="mb-3 flex items-start gap-3">
				<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
					</svg>
				</div>
				<div>
					<p class="text-sm font-medium text-text">
						{t('passkeySetupTitle')}
					</p>
					<p class="mt-0.5 text-xs text-text-muted">
						{t('passkeySetupDescription')}
					</p>
				</div>
			</div>

			{#if error}
				<p class="mb-3 text-xs text-danger">{error}</p>
			{/if}

			<div class="flex gap-2">
				<button
					onclick={setupPasskey}
					disabled={registering}
					class="flex-1 rounded-[var(--radius-md)] bg-accent px-3 py-1.5 text-xs font-medium text-white
						transition-colors hover:bg-accent-hover disabled:opacity-50"
				>
					{registering ? (t('passkeySetupRegistering')) : (t('passkeySetupCta'))}
				</button>
				<button
					onclick={dismiss}
					class="rounded-[var(--radius-md)] px-3 py-1.5 text-xs text-text-muted
						transition-colors hover:text-text hover:bg-bg-subtle"
				>
					{t('passkeySetupDismiss')}
				</button>
			</div>
		{/if}
	</div>
{/if}
