<script lang="ts">
	// PRD-HN-LAUNCH-HARDENING tier-1 item 5.
	// Renders ONLY when the engine reports `public_demo: true` (set on the
	// engine.lynox.cloud container via `LYNOX_PUBLIC_DEMO=true`). Customer
	// self-host stays clean — env var is absent, banner never shows.
	//
	// Dismissible via the X button; the choice is sticky in localStorage so
	// the banner doesn't keep nagging across page reloads. Wording is written
	// natively in DE + EN (not translated — see core/CLAUDE.md i18n rule).
	import { onMount } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	let isPublicDemo = $state(false);
	let dismissed = $state(false);
	let loaded = $state(false);

	const DISMISS_KEY = 'lynox-public-demo-banner-dismissed';

	onMount(async () => {
		try {
			// Reuse the existing /api/secrets/status endpoint which already exposes
			// managed-mode + provider so we don't need to add a second probe.
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (res.ok) {
				const data = (await res.json()) as { public_demo?: boolean };
				isPublicDemo = data.public_demo === true;
			}
		} catch {
			// /secrets/status failures are handled elsewhere (StatusBar). Banner
			// silently stays hidden — better to skip the warning than to render
			// it against an engine-down state.
		}
		dismissed = localStorage.getItem(DISMISS_KEY) === '1';
		loaded = true;
	});

	function dismiss() {
		dismissed = true;
		localStorage.setItem(DISMISS_KEY, '1');
	}

	// Tiny in-place markdown renderer: only handles **bold** and [text](url).
	// We deliberately avoid a full markdown library to keep this file standalone
	// and to make the rendered output reviewable at a glance — the banner copy
	// is a fixed string from the i18n table, not arbitrary user input.
	function renderInline(src: string): string {
		// Escape HTML first to prevent injection if the i18n string ever gets
		// loaded from a remote source in future.
		const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		// **bold**
		const bolded = esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
		// [text](url) — only allow http(s) URLs to be defensive
		return bolded.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) => {
			return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-200">${text}</a>`;
		});
	}

	const bannerHtml = $derived(renderInline(t('banner.public_demo')));
</script>

{#if loaded && isPublicDemo && !dismissed}
	<div
		role="alert"
		class="flex items-start justify-between gap-3 border-b border-amber-200/60 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/30 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-100 shrink-0"
	>
		<div class="flex items-start gap-2 min-w-0">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
				<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
			</svg>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<span class="leading-snug">{@html bannerHtml}</span>
		</div>
		<button
			onclick={dismiss}
			class="text-amber-700/70 dark:text-amber-200/70 hover:text-amber-900 dark:hover:text-amber-100 transition-colors shrink-0 mt-0.5"
			aria-label={t('banner.dismiss')}
		>
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
			</svg>
		</button>
	</div>
{/if}
