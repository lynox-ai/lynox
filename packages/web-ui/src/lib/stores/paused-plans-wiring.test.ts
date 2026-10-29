import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Read from the source, not rendered: mounting the whole shell needs every store it starts. What it
// holds is that the dot sits at "Automation", is started and stopped with the shell, and is read out
// with its own label rather than the approvals' one.
describe('the shell wires the dot', () => {
	const shell = readFileSync(fileURLToPath(new URL('../components/AppShell.svelte', import.meta.url)), 'utf8');
	it('at Automation, with its label, started and stopped with the shell', () => {
		expect(shell).toContain("{ href: '/app/hub', labelKey: 'nav.automation', exact: false, icon: 'workflow', badge: getPausedPlansBadge(), badgeLabelKey: 'nav.paused_badge' }");
		expect(shell).toContain('stopPausedPlansNav = startPausedPlansNav();');
		expect(shell).toContain('stopPausedPlansNav?.();');
		expect(shell).toContain("tf(item.badgeLabelKey ?? 'nav.approvals_badge', { count: String(item.badge) })");
	});
	it('and at the menu button, where a phone folds the navigation away (ux UX-032)', () => {
		expect(shell).toContain("const foldedBadges = $derived(nav.filter((item) => typeof item.badge === 'number' && item.badge > 0));");
		expect(shell).toMatch(/\{#if foldedBadges\.length > 0\}\s*<span [^>]*data-menu-badge><\/span>/);
		expect(shell).toContain("aria-label={['Open menu', ...foldedBadges.map((item) => tf(item.badgeLabelKey ?? 'nav.approvals_badge', { count: String(item.badge) }))].join('. ')}");
	});
});
