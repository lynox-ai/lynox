/**
 * The owner's lines of allowed link domains, read the way the engine reads them
 * (`normalizeStartDomains` in core's bulk-ledger.ts): a host name with a dot, no wildcard, path,
 * port, credentials or address literal, not a shared suffix such as `co.uk` or `myshopify.com`,
 * at most 20. The engine decides; this marks a wrong line
 * before the start, so the refusal at the route stays a net the owner never meets.
 */

export const START_DOMAINS_MAX = 20;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// Copies of core's public-suffix.ts; core's bulk-start-domains.test.ts holds them equal.
const PUBLIC_SECOND_LEVEL_LABELS: readonly string[] = [
	'co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'ltd', 'plc',
];
const SHARED_PLATFORM_DOMAINS: readonly string[] = [
	'myshopify.com', 'github.io', 'vercel.app', 'netlify.app', 'pages.dev', 'wixsite.com',
	'squarespace.com', 'web.app', 'herokuapp.com',
];

/** The host name a line names, or null where it is not one. */
export function startDomainOf(line: string): string | null {
	const d = line.trim();
	if (d.length === 0 || d.length > 253 || /[/?#@:\\*%\s]/.test(d)) return null;
	let host: string;
	try {
		host = new URL(`https://${d}/`).hostname;
	} catch {
		return null;
	}
	const labels = host.split('.');
	if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return null;
	// A shared suffix alone would allow every name under it.
	if (SHARED_PLATFORM_DOMAINS.includes(host)) return null;
	if (labels.length === 2 && /^[a-z]{2}$/.test(labels[1]!) && PUBLIC_SECOND_LEVEL_LABELS.includes(labels[0]!)) return null;
	return host;
}

export interface StartDomainLines {
	/** The host names, in the order typed, without duplicates. */
	domains: string[];
	/** The lines (0-based, empty lines counted) that name no host. */
	badLines: number[];
	tooMany: boolean;
}

/** One domain per line; a comma separates too. Empty lines are skipped. */
export function readStartDomainLines(text: string): StartDomainLines {
	const domains: string[] = [];
	const badLines: number[] = [];
	text.split('\n').forEach((line, i) => {
		for (const part of line.split(',')) {
			if (part.trim().length === 0) continue;
			const host = startDomainOf(part);
			if (host === null) {
				if (!badLines.includes(i)) badLines.push(i);
			} else if (!domains.includes(host)) {
				domains.push(host);
			}
		}
	});
	return { domains, badLines, tooMany: domains.length > START_DOMAINS_MAX };
}
