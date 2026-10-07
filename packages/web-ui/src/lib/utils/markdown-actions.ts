/**
 * Which of the markdown view's own controls a click landed on.
 *
 * The view builds controls into a message (diagram buttons, artifact cards) and handles their
 * clicks on the message container. Class names and `data-*` attributes cannot tell those controls
 * apart from look-alikes in the message itself: the sanitizer keeps `button`, `class` and `data-*`.
 * So every control the view builds carries `OWN_ATTR`, an attribute the sanitizer's default
 * configuration removes from message markup, and a click counts only when the control AND the
 * element it acts on both carry it.
 */

/** Set on every control the view builds, and on the element each control acts on. */
export const OWN_ATTR = 'lynox-own';

/** The attribute as it is written into built markup. */
export const OWN_MARK = ` ${OWN_ATTR}`;

export type OwnAction =
	| { readonly kind: 'mermaid-export'; readonly diagram: Element }
	| { readonly kind: 'mermaid-save'; readonly button: HTMLElement }
	| { readonly kind: 'artifact'; readonly action: string | undefined; readonly container: HTMLElement }
	| { readonly kind: 'toggle'; readonly container: HTMLElement };

const own = (selector: string): string => `${selector}[${OWN_ATTR}]`;

/** The view's own control under `target`, or null when the click is not on one. */
export function resolveOwnAction(target: Element): OwnAction | null {
	const exportBtn = target.closest(own('.mermaid-export'));
	if (exportBtn) {
		const diagram = exportBtn.closest(own('.mermaid-diagram'));
		return diagram ? { kind: 'mermaid-export', diagram } : null;
	}
	const saveBtn = target.closest(own('.mermaid-save'));
	if (saveBtn) return { kind: 'mermaid-save', button: saveBtn as HTMLElement };

	// A toolbar button wins over the toolbar it sits in.
	const artifactBtn = target.closest(own('.artifact-btn'));
	if (artifactBtn) {
		const container = artifactBtn.closest(own('.artifact-container'));
		return container
			? { kind: 'artifact', action: (artifactBtn as HTMLElement).dataset['action'], container: container as HTMLElement }
			: null;
	}
	const toggle = target.closest(own('[data-action="toggle"]'));
	if (toggle) {
		const container = toggle.closest(own('.artifact-container'));
		return container ? { kind: 'toggle', container: container as HTMLElement } : null;
	}
	return null;
}
