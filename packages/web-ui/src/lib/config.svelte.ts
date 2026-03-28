interface WebUIConfig {
	apiBase: string;
}

let apiBase = $state('/api/engine');

export function configure(opts: Partial<WebUIConfig>): void {
	if (opts.apiBase !== undefined) apiBase = opts.apiBase;
}

export function getApiBase(): string {
	return apiBase;
}
