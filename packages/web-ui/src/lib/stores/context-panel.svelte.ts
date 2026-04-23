export type ContextType = 'tool' | 'entity' | 'file' | 'spawn' | 'none';

export interface SpawnChildResult {
	name: string;
	ok: boolean;
	elapsedS: number;
}

export interface ContextInfo {
	type: ContextType;
	toolName?: string;
	toolInput?: unknown;
	toolResult?: string;
	filePath?: string;
	title: string;
	// Spawn-specific fields. Populated when type === 'spawn' so the sidebar
	// can render the same sub-agent view ChatView shows inline — running/done
	// counts, elapsed time, last tool per sub-agent.
	spawnAgents?: string[];
	spawnRunning?: string[];
	spawnDone?: SpawnChildResult[];
	spawnLastTool?: Record<string, string>;
	spawnElapsedS?: number;
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
