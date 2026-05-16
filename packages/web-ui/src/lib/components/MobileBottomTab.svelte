<script lang="ts">
	/**
	 * Mobile Bottom-Tab — PRD-IA-V2 P2-PR-E
	 *
	 * Net-new component (not a refactor). AppShell previously only had a
	 * desktop nav-rail; mobile users navigated exclusively via the burger →
	 * drawer. The 5-slot bottom-tab gives daily flows (Chat / Inbox / Activity
	 * / Intelligence) one-tap reach within thumb range, and folds the
	 * lower-frequency surfaces (Hub, Artefakte, Settings, Logout) into a
	 * "Mehr" drawer.
	 *
	 * Hard constraints from PRD Round-1 UX U5:
	 * - Chat sits in position 1 — left-thumb invariant.
	 * - Tap-targets ≥ 44×44px (iOS HIG).
	 * - Only renders below the `md:` breakpoint — desktop keeps the nav-rail.
	 *
	 * Inbox is feature-flag gated. We accept the prop from AppShell rather
	 * than re-probing the flag so the two stay in sync; if the flag is off
	 * we keep the slot but route to /app (no dead link, no layout shift).
	 */
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { t } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import type { IconName } from '../primitives/icons.js';

	let { inboxEnabled = false }: { inboxEnabled?: boolean } = $props();

	let drawerOpen = $state(false);

	interface TabItem {
		id: string;
		href: string;
		labelKey: string;
		icon: IconName;
		// `exact: true` matches only the literal pathname. Used for /app (Chat)
		// so navigating to /app/hub doesn't keep Chat highlighted.
		exact?: boolean;
	}

	const tabs: TabItem[] = [
		// Position 1 = Chat (left-thumb invariant per U5).
		{ id: 'chat', href: '/app', labelKey: 'mobile_nav.chat', icon: 'chat', exact: true },
		{ id: 'inbox', href: '/app/inbox', labelKey: 'mobile_nav.inbox', icon: 'inbox' },
		{ id: 'activity', href: '/app/activity', labelKey: 'mobile_nav.activity', icon: 'clock' },
		{ id: 'intelligence', href: '/app/intelligence', labelKey: 'mobile_nav.intelligence', icon: 'brain' },
		// "Mehr" is the 5th slot — opens an inline drawer. No href because it
		// doesn't navigate; the click handler toggles `drawerOpen`.
		{ id: 'more', href: '', labelKey: 'mobile_nav.more', icon: 'hamburger' },
	];

	function isActive(tab: TabItem): boolean {
		const path = $page.url.pathname;
		if (tab.id === 'more') return drawerOpen;
		if (tab.exact) return path === tab.href;
		return path.startsWith(tab.href);
	}

	function onTabClick(tab: TabItem, e: MouseEvent): void {
		if (tab.id === 'more') {
			e.preventDefault();
			drawerOpen = !drawerOpen;
			return;
		}
		// Inbox flag off → degrade to /app so the tap is never a dead link.
		// Don't hide the slot — layout-shift would be more confusing than a
		// silently re-routed tap.
		if (tab.id === 'inbox' && !inboxEnabled) {
			e.preventDefault();
			void goto('/app');
			return;
		}
		drawerOpen = false;
	}

	interface DrawerItem {
		href: string;
		labelKey: string;
		icon: IconName;
	}

	// `/logout` is a full-page nav target — the server clears the session
	// cookie and redirects. We deliberately don't intercept it with `goto()`
	// so the cookie clear actually happens server-side.
	const drawerItems: DrawerItem[] = [
		{ href: '/app/hub', labelKey: 'mobile_nav.drawer.hub', icon: 'workflow' },
		{ href: '/app/artifacts', labelKey: 'mobile_nav.drawer.artifacts', icon: 'artifacts' },
		{ href: '/app/settings', labelKey: 'mobile_nav.drawer.settings', icon: 'settings' },
		{ href: '/logout', labelKey: 'mobile_nav.drawer.logout', icon: 'logout' },
	];

	function onDrawerItemClick(): void {
		drawerOpen = false;
	}

	function closeDrawer(): void {
		drawerOpen = false;
	}

	// Close drawer on Escape — matches AppShell's sidebar pattern.
	$effect(() => {
		function handleEscape(e: KeyboardEvent): void {
			if (e.key === 'Escape' && drawerOpen) drawerOpen = false;
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});
</script>

<!--
	Mobile chrome. `md:hidden` on the wrapper means nothing renders or paints
	on desktop, including the drawer overlay.

	The tab-bar itself sits in normal flow (not `position: fixed`) so the
	right-column flex layout above it shrinks to make room — no overlap with
	the chat input, no `padding-bottom: 56px` hack on `<main>`. The drawer,
	by contrast, is `fixed` because it needs to escape its parent's flow and
	float above whatever the user was reading.
-->
<div class="md:hidden">
	{#if drawerOpen}
		<!-- Backdrop. Click anywhere outside the sheet to close. -->
		<button
			type="button"
			class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
			onclick={closeDrawer}
			aria-label={t('mobile_nav.drawer.close')}
		></button>
		<!--
			Bottom sheet. Sits above the tab-bar (which is in-flow, no z-index
			needed) so the items are reachable; the tab-bar itself stays
			visible underneath so the user can tap "Mehr" again to dismiss
			without hunting for the X. `bottom-14` clears the ~56px tab-bar.
		-->
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t('mobile_nav.drawer.title')}
			class="fixed inset-x-0 bottom-14 z-40 border-t border-border bg-bg shadow-2xl"
			style="padding-bottom: env(safe-area-inset-bottom, 0px);"
		>
			<div class="px-3 pt-2 pb-1">
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle px-2 pb-1">
					{t('mobile_nav.drawer.title')}
				</p>
				<ul class="divide-y divide-border">
					{#each drawerItems as item}
						<li>
							<a
								href={item.href}
								onclick={onDrawerItemClick}
								class="flex items-center gap-3 min-h-[44px] px-2 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-muted transition-colors rounded-[var(--radius-sm)]"
							>
								<Icon name={item.icon} size="sm" />
								<span>{t(item.labelKey)}</span>
							</a>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<!--
		Tab-bar. min-h sized to 56px so each slot is at least 44×44 including
		the font label below the icon. iPhone SE = 375px / 5 slots = 75px each
		— comfortably above the 44px tap-target floor.

		`grid grid-cols-5` keeps every slot equal-width even as the label
		lengths drift between locales (DE "Aktivität" vs EN "Activity").
	-->
	<nav
		aria-label={t('mobile_nav.aria_label')}
		class="grid grid-cols-5 border-t border-border bg-bg-subtle shrink-0"
		style="padding-bottom: env(safe-area-inset-bottom, 0px);"
	>
		{#each tabs as tab (tab.id)}
			{@const active = isActive(tab)}
			<a
				href={tab.href || '#'}
				onclick={(e) => onTabClick(tab, e)}
				aria-current={active ? 'page' : undefined}
				class="flex flex-col items-center justify-center gap-0.5 min-h-[56px] px-1 py-1.5 text-[10px] transition-colors
				{active
					? 'text-accent-text bg-accent/10'
					: 'text-text-subtle hover:text-text'}"
			>
				<Icon name={tab.icon} size="sm" />
				<span class="truncate max-w-full">{t(tab.labelKey)}</span>
			</a>
		{/each}
	</nav>
</div>
