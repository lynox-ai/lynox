/**
 * The owner's lines of allowed link domains, read the way the engine reads them
 * (`normalizeStartDomains` in core's bulk-ledger.ts): a host name with a dot, no wildcard, path,
 * port, credentials or address literal, at most 20. The engine decides; this marks a wrong line
 * before the start, so the refusal at the route stays a net the owner never meets.
 */

export const START_DOMAINS_MAX = 20;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

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
	if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return null;
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
