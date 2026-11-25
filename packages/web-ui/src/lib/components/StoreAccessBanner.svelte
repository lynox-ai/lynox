<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { getLocale, t, tf } from '../i18n.svelte.js';
	import { untrack } from 'svelte';
	import { connectHref } from '../oauth-connect-path.js';
	import { isOwnerSession, isViewerKnown, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import { storeAccessAskAgain, storeAccessEndPassed, storeAccessShown, type StoreAccessProfile } from '../utils/store-access-end.js';
	import { placeholderParts } from '../utils/value-breaks.js';
	import WholeValue from './WholeValue.svelte';

	// The owner's line per store whose access runs out soon or has (U-391): without web push the
	// owner learns of it here, before the end, and not only when a run halts. Hidden until the next
	// load at most, never for good: the end would come unnoticed again. The host's box moves to the
	// next line whole; only a host longer than a line breaks in it, after a dot. Shown once the server named
	// the session the owner's, also when that answer comes late (a retry).
	let profiles = $state<StoreAccessProfile[]>([]);
	let dismissed = $state(false);
	// When the question the profiles answer was sent. The lines read the ends as of then: an end
	// that passes while the tab stays open is not called ended until the engine has been asked
	// after it (a run may renew the store meanwhile). The time is this browser's, sent with the
	// question; the engine's own `ended` always counts.
	let askedAt = $state<number | null>(null);
	// Whether the last question went unanswered. A line still "soon" as of the last answer whose end
	// has passed since then says the page cannot check it now, not a date in the past as if ahead.
	let askFailed = $state(false);
	let now = $state(new Date());
	const lines = $derived(askedAt === null ? [] : profiles.flatMap((p) => {
		const shown = storeAccessShown(p, new Date(askedAt!), getLocale());
		if (shown === null) return [];
		return [{ ...shown, unknown: shown.kind === 'soon' && askFailed && storeAccessEndPassed(p, now) }];
	}));

	// None hangs: a question that gets no answer is given up after this long, and the next minute
	// asks again. The viewer is waited for a shorter while: an answer that does not come is a viewer
	// not named yet, whose profiles are asked (the same route serves every user); the line shows
	// only once the server names the owner, and stays hidden when it names a mandate later.
	const QUESTION_MS = 15_000;
	const VIEWER_MS = 5_000;
	// One question at a time. Today a question ends before the next minute's look; the flag keeps it
	// so if the limit above is ever raised past a minute or another start is added.
	let asking = false;

	async function load(): Promise<void> {
		if (asking) return;
		asking = true;
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), QUESTION_MS);
		let viewerWait: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([loadSettingsViewer(), new Promise<void>((r) => { viewerWait = setTimeout(r, VIEWER_MS); })]);
			clearTimeout(viewerWait);
			// A session the server named another's is not asked; one not named yet is, and shows only
			// once the owner's.
			if (isViewerKnown() && !isOwnerSession()) return;
			const sent = Date.now();
			const res = await fetch(`${getApiBase()}/api-profiles`, { signal: abort.signal });
			if (!res.ok) { askFailed = true; return; }
			const data = (await res.json()) as { profiles?: StoreAccessProfile[] };
			profiles = data.profiles ?? [];
			askedAt = sent;
			askFailed = false;
		} catch { askFailed = true; /* StatusBar handles an engine that is down; the next minute asks again */ } finally {
			clearTimeout(viewerWait);
			clearTimeout(timeout);
			asking = false;
		}
	}

	$effect(() => {
		untrack(() => void load());
		// An end that passes while the page is open: the engine is asked again within a minute, and
		// the line says what it answers (renewed, or ended).
		const timer = setInterval(() => {
			now = new Date();
			if (storeAccessAskAgain(profiles, askedAt, now)) void load();
		}, 60_000);
		return () => clearInterval(timer);
	});
</script>

{#if lines.length > 0 && !dismissed && isOwnerSession()}
	<div role="status" class="border-b border-warning/30 bg-warning-subtle px-4 py-2.5 flex items-start justify-between gap-3" data-testid="store-access-banner">
		<ul class="space-y-2 min-w-0">
			{#each lines as line (line.profileId)}
				{@const parts = placeholderParts(tf(line.unknown ? 'store_access.banner_unknown' : line.kind === 'soon' ? 'store_access.banner_soon' : 'store_access.banner_ended', { date: line.date, host: '{host}' }), '{host}')}
				<li class="flex items-center gap-3 flex-wrap text-[12px] text-warning" data-testid="store-access-line">
					<span class="min-w-0 break-words">{parts.before}<WholeValue value={line.host} class="font-mono rounded-[var(--radius-sm)] bg-bg-muted px-1 py-0.5 text-text" testid="store-access-host" />{parts.after}</span>
					<!-- A full page load: the engine's route answers with a page or a redirect to the provider. -->
					<a href={connectHref(getApiBase(), line.profileId)} data-sveltekit-reload data-testid="store-access-reconnect"
						class="shrink-0 rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-[12px] text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
				</li>
			{/each}
		</ul>
		<button onclick={() => (dismissed = true)} class="shrink-0 text-[12px] text-warning/70 hover:text-warning transition-colors" data-testid="store-access-dismiss">{t('banner.dismiss')}</button>
	</div>
{/if}
