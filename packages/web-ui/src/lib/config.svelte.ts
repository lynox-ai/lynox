interface WebUIConfig {
	apiBase: string;
	pipelineStatusV2: boolean;
}

let apiBase = $state('/api');
// Off by default. Flipped on for canary via configure({ pipelineStatusV2: true })
// or via the PUBLIC_LYNOX_UI_PIPELINE_STATUS_V2 env (resolved by the host bundle —
// SvelteKit standalone reads it at build time, library consumers pass it through
// configure()).
let pipelineStatusV2 = $state(false);

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
