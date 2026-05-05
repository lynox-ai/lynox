interface WebUIConfig {
	apiBase: string;
	pipelineStatusV2: boolean;
}

let apiBase = $state('/api');
// On by default. Library consumers can opt out via
// configure({ pipelineStatusV2: false }) for the legacy chrome.
let pipelineStatusV2 = $state(true);

export function configure(opts: Partial<WebUIConfig>): void {
	if (opts.apiBase !== undefined) apiBase = opts.apiBase;
	if (opts.pipelineStatusV2 !== undefined) pipelineStatusV2 = opts.pipelineStatusV2;
}

export function getApiBase(): string {
	return apiBase;
}

export function getPipelineStatusV2(): boolean {
	return pipelineStatusV2;
}
