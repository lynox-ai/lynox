export type ContextType = 'tool' | 'entity' | 'file' | 'none';

export interface ContextInfo {
	type: ContextType;
	toolName?: string;
	toolInput?: unknown;
	toolResult?: string;
	filePath?: string;
	title: string;
}

let activeContext = $state<ContextInfo | null>(null);
let pinned = $state(false);

export function setContext(ctx: ContextInfo): void {
	if (pinned) return;
	activeContext = ctx;
}

export function clearContext(): void {
	if (pinned) return;
	activeContext = null;
}

export function getContext(): ContextInfo | null {
	return activeContext;
}

export function isPinned(): boolean {
	return pinned;
}

export function togglePin(): void {
	pinned = !pinned;
}

export function closePanel(): void {
	pinned = false;
	activeContext = null;
}
