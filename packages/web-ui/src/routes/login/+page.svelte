<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let loading = $state(false);

	// OTP flow state
	let otpStep = $state<'email' | 'code'>('email');
	// Local error cleared on step transitions (prevents stale cross-step errors)
	let localError = $state<string | null>(null);
	// Track the email used for OTP (initialized from server data via derived)
	let _emailOverride = $state<string | null>(null);
	let submittedEmail = $derived(_emailOverride ?? data.customerEmail ?? '');

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
			<!-- Managed: Email OTP flow -->
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
