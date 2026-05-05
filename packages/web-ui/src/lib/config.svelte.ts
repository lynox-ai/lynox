interface WebUIConfig {
	apiBase: string;
	pipelineStatusV2: boolean;
	contextPanelEnabled: boolean;
}

let apiBase = $state('/api');
// On by default. Library consumers can opt out via
// configure({ pipelineStatusV2: false }) for the legacy chrome.
let pipelineStatusV2 = $state(true);
// Off by default while the right-sidebar is being reworked. Library consumers
// who already wire context-panel updates can opt back in via
// configure({ contextPanelEnabled: true }) until the rework lands.
let contextPanelEnabled = $state(false);

export function configure(opts: Partial<WebUIConfig>): void {
	if (opts.apiBase !== undefined) apiBase = opts.apiBase;
	if (opts.pipelineStatusV2 !== undefined) pipelineStatusV2 = opts.pipelineStatusV2;
	if (opts.contextPanelEnabled !== undefined) contextPanelEnabled = opts.contextPanelEnabled;
}

export function getApiBase(): string {
	return apiBase;
}

export function getPipelineStatusV2(): boolean {
	return pipelineStatusV2;
}

export function getContextPanelEnabled(): boolean {
	return contextPanelEnabled;
}
