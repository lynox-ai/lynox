<script lang="ts">
	import { enhance } from '$app/forms';
	import { startAuthentication } from '@simplewebauthn/browser';
	import type { ActionData, PageData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);

	// OTP flow state
	let otpStep = $state<'email' | 'code'>('email');
	let localError = $state<string | null>(null);
	let _emailOverride = $state<string | null>(null);
	let submittedEmail = $derived(_emailOverride ?? data.customerEmail ?? '');

	// Passkey state
	let passkeyLoading = $state(false);
	let _otpFallbackOverride = $state<boolean | null>(null);
	let showOtpFallback = $derived(_otpFallbackOverride ?? !data.hasPasskeys);

	// Advance to code step when OTP is sent
	$effect(() => {
		if (form && 'otpSent' in form && form.otpSent === true) {
			if ('email' in form && typeof form.email === 'string') {
				_emailOverride = form.email;
			}
			localError = null;
			otpStep = 'code';
		} else if (form && 'error' in form && typeof form.error === 'string') {
			localError = form.error;
		}
	});

	function goBackToEmail() {
		otpStep = 'email';
		localError = null;
	}

	/** Attempt passkey authentication via WebAuthn API. */
	async function loginWithPasskey() {
		passkeyLoading = true;
		localError = null;

		try {
			// 1. Get authentication options from control plane
			const startRes = await fetch('/api/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'authenticate/start' }),
			});

			if (!startRes.ok) {
				const err = await startRes.json().catch(() => ({})) as { noCredentials?: boolean; error?: string };
				if (err.noCredentials) {
					_otpFallbackOverride = true;
					return;
				}
				localError = err.error ?? 'Could not start passkey authentication.';
				return;
			}

			const options = await startRes.json();
			if (options.noCredentials) {
				_otpFallbackOverride = true;
				return;
			}

			// 2. Prompt the user's authenticator (Face ID / Touch ID / Security Key)
			const authResponse = await startAuthentication({ optionsJSON: options });

			// 3. Verify with control plane
			const verifyRes = await fetch('/api/passkey', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'authenticate/complete', response: authResponse }),
			});

			const verifyData = await verifyRes.json() as { valid?: boolean; error?: string };

			if (!verifyRes.ok || !verifyData.valid) {
				localError = verifyData.error ?? 'Passkey verification failed.';
				return;
			}

			// 4. Create session via form action
			const formData = new FormData();
			formData.set('valid', 'true');
			const sessionRes = await fetch('?/passkeyAuth', {
				method: 'POST',
				body: formData,
			});

			const sessionResult = await sessionRes.json() as { type?: string; location?: string };
			if (sessionResult.type === 'redirect' && sessionResult.location) {
				window.location.href = sessionResult.location;
			} else {
				localError = 'Session creation failed.';
			}
		} catch (err: unknown) {
			// User cancelled the authenticator prompt
			if (err instanceof Error && err.name === 'NotAllowedError') {
				return; // Silent — user cancelled
			}
			localError = 'Passkey authentication failed. Try again or use email code.';
			_otpFallbackOverride = true;
		} finally {
			passkeyLoading = false;
		}
	}

	const isDE = typeof navigator !== 'undefined' && navigator.language.startsWith('de');
</script>

<svelte:head>
	<title>Login — lynox</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-bg px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 flex flex-col items-center gap-4">
			<img src="/logo.svg" alt="lynox" class="h-20" />
			{#if data.isManaged}
				<p class="text-sm text-text-muted">
					{isDE ? 'Mit deiner E-Mail-Adresse anmelden.' : 'Sign in with your email.'}
				</p>
			{:else}
				<p class="text-sm text-text-muted">
					{isDE ? 'Access Token eingeben um fortzufahren.' : 'Enter your access token to continue.'}
				</p>
			{/if}
		</div>

		{#if data.isManaged}
			<!-- Passkey-first login (if passkeys registered) -->
			{#if data.hasPasskeys && !showOtpFallback}
				<div class="space-y-4">
					{#if localError}
						<div class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
							{localError}
						</div>
					{/if}

					<button
						type="button"
						onclick={loginWithPasskey}
						disabled={passkeyLoading}
						class="w-full rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white
							transition-colors hover:bg-accent-hover disabled:opacity-50 flex items-center justify-center gap-2"
					>
						{#if passkeyLoading}
							<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"></span>
							{isDE ? 'Warte auf Bestätigung...' : 'Waiting for confirmation...'}
						{:else}
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
							</svg>
							{isDE ? 'Mit Passkey anmelden' : 'Sign in with Passkey'}
						{/if}
					</button>

					<button
						type="button"
						onclick={() => { _otpFallbackOverride = true; localError = null; }}
						class="w-full text-center text-sm text-text-muted hover:text-text transition-colors"
					>
						{isDE ? 'Stattdessen Code per E-Mail' : 'Use email code instead'}
					</button>
				</div>
			{:else}
				<!-- OTP flow (primary or fallback) -->
				{#if otpStep === 'email'}
					<form
						method="POST"
						action="?/requestOtp"
						use:enhance={() => {
							loading = true;
							localError = null;
							return async ({ update }) => {
								loading = false;
								await update();
							};
						}}
						class="space-y-4"
					>
						{#if localError}
							<div class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
								{localError}
							</div>
						{/if}

						<div>
							<label for="email" class="mb-1.5 block text-sm text-text-muted">
								{isDE ? 'E-Mail-Adresse' : 'Email address'}
							</label>
							<input
								id="email"
								name="email"
								type="email"
								autocomplete="email"
								required
								value={submittedEmail}
								readonly={!!data.customerEmail}
								class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5 text-text
									placeholder:text-text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent
									{data.customerEmail ? 'opacity-60' : ''}"
							/>
						</div>

						<button
							type="submit"
							disabled={loading}
							class="w-full rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white
								transition-colors hover:bg-accent-hover disabled:opacity-50"
						>
							{loading
								? (isDE ? 'Wird gesendet...' : 'Sending...')
								: (isDE ? 'Code senden' : 'Send code')}
						</button>

						{#if data.hasPasskeys}
							<button
								type="button"
								onclick={() => { _otpFallbackOverride = false; localError = null; }}
								class="w-full text-center text-sm text-text-muted hover:text-text transition-colors"
							>
								{isDE ? 'Mit Passkey anmelden' : 'Sign in with Passkey'}
							</button>
						{/if}
					</form>
				{:else}
					<!-- OTP Code entry -->
					<form
						method="POST"
						action="?/verifyOtp"
						use:enhance={() => {
							loading = true;
							localError = null;
							return async ({ update }) => {
								loading = false;
								await update();
							};
						}}
						class="space-y-4"
					>
						{#if localError}
							<div class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
								{localError}
							</div>
						{/if}

						<p class="text-sm text-text-muted">
							{isDE
								? `Wir haben einen Code an ${submittedEmail} gesendet.`
								: `We sent a code to ${submittedEmail}.`}
						</p>

						<input type="hidden" name="email" value={submittedEmail} />

						<div>
							<label for="code" class="mb-1.5 block text-sm text-text-muted">
								{isDE ? 'Bestätigungscode' : 'Verification code'}
							</label>
							<input
								id="code"
								name="code"
								type="text"
								inputmode="numeric"
								pattern={'[0-9 \\-]{6,20}'}
								maxlength={20}
								autocomplete="one-time-code"
								required
								autofocus
								placeholder="000000"
								class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5 text-center
									font-mono text-lg tracking-[0.3em] text-text placeholder:text-text-subtle
									focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
							/>
						</div>

						<button
							type="submit"
							disabled={loading}
							class="w-full rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white
								transition-colors hover:bg-accent-hover disabled:opacity-50"
						>
							{loading
								? (isDE ? 'Wird geprüft...' : 'Verifying...')
								: (isDE ? 'Anmelden' : 'Sign in')}
						</button>

						<button
							type="button"
							onclick={goBackToEmail}
							class="w-full text-center text-sm text-text-muted hover:text-text transition-colors"
						>
							{isDE ? 'Anderen Code anfordern' : 'Request a new code'}
						</button>
					</form>
				{/if}
			{/if}
		{:else}
			<!-- Self-hosted: Token login -->
			<form
				method="POST"
				action="?/token"
				use:enhance={() => {
					loading = true;
					return async ({ update }) => {
						loading = false;
						await update();
					};
				}}
				class="space-y-4"
			>
				{#if form?.error}
					<div
						class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
					>
						{form.error}
					</div>
				{/if}

				<div>
					<label for="token" class="mb-1.5 block text-sm text-text-muted">Access Token</label>
					<input
						id="token"
						name="token"
						type="password"
						autocomplete="current-password"
						required
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2.5 text-text
							placeholder:text-text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
					/>
				</div>

				<button
					type="submit"
					disabled={loading}
					class="w-full rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-medium text-white
						transition-colors hover:bg-accent-hover disabled:opacity-50"
				>
					{loading ? (isDE ? 'Wird geprüft...' : 'Verifying...') : (isDE ? 'Weiter' : 'Continue')}
				</button>
			</form>

			<p class="mt-6 text-center text-xs text-text-subtle">
				{isDE ? 'Token verloren?' : 'Lost it?'} <code class="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-xs">docker logs lynox</code>
			</p>
		{/if}
	</div>
</div>
