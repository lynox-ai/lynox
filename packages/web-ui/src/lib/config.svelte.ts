interface WebUIConfig {
	apiBase: string;
}

let apiBase = $state('/api');

export function configure(opts: Partial<WebUIConfig>): void {
	if (opts.apiBase !== undefined) apiBase = opts.apiBase;
}

export function getApiBase(): string {
	return apiBase;
}
