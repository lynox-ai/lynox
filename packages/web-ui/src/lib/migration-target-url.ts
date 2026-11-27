/**
 * The browser's check of a migration target's address, by the engine's rule: https, and not a
 * local, private, link-local or otherwise reserved address (`isPrivateIP` in the engine's network
 * guard). A name that resolves to such an address is only found by the engine, which looks it up.
 */

function v4Octets(text: string): number[] | null {
	const parts = text.split('.');
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
	const nums = parts.map(Number);
	return nums.some((n) => n > 255) ? null : nums;
}

function privateV4(o: readonly number[]): boolean {
	const [a = 0, b = 0, c = 0] = o;
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
		|| (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
		|| (a === 192 && b === 0 && c === 0) || a === 0 || a >= 224;
}

/** The 16 bytes of an IPv6 address as the URL parser writes it (compressed, lowercase), or null. */
function v6Bytes(addr: string): number[] | null {
	let s = addr;
	const lastColon = s.lastIndexOf(':');
	const quad = s.slice(lastColon + 1);
	if (quad.includes('.')) {
		const o = v4Octets(quad);
		if (o === null) return null;
		const [a = 0, b = 0, c = 0, d = 0] = o;
		s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const groups = (part: string): number[] | null => {
		if (part === '') return [];
		const out: number[] = [];
		for (const g of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			const n = parseInt(g, 16);
			out.push((n >> 8) & 0xff, n & 0xff);
		}
		return out;
	};
	const head = groups(halves[0] ?? '');
	if (head === null) return null;
	if (halves.length === 1) return head.length === 16 ? head : null;
	const tail = groups(halves[1] ?? '');
	if (tail === null || head.length + tail.length > 16) return null;
	return [...head, ...new Array<number>(16 - head.length - tail.length).fill(0), ...tail];
}

function privateV6(bytes: readonly number[]): boolean {
	const at = (i: number): number => bytes[i] ?? 0;
	const zero = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);
	if (zero(0, 16)) return true;
	if (zero(0, 15) && at(15) === 1) return true;
	if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true;
	if ((at(0) & 0xfe) === 0xfc) return true;
	if (at(0) === 0xff) return true;
	if (at(0) === 0 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && at(4) === 0 && at(5) === 1) return true;
	const v4 = zero(0, 12) ? bytes.slice(12, 16)
		: zero(0, 10) && at(10) === 0xff && at(11) === 0xff ? bytes.slice(12, 16)
			: zero(0, 8) && at(8) === 0xff && at(9) === 0xff && zero(10, 12) ? bytes.slice(12, 16)
				: at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && zero(0, 1) && zero(4, 12) ? bytes.slice(12, 16)
					: at(0) === 0x20 && at(1) === 0x02 ? bytes.slice(2, 6)
						: null;
	return v4 !== null && privateV4(v4);
}

/** Whether an address literal (an IPv4, or an IPv6 without its brackets) is one the engine refuses. */
export function isPrivateAddressLiteral(host: string): boolean {
	const h = host.toLowerCase();
	if (!h.includes(':')) {
		const o = v4Octets(h);
		return o !== null && privateV4(o);
	}
	const bytes = v6Bytes(h);
	return bytes !== null && privateV6(bytes);
}

/** Whether the engine would take `url` as a migration target, as far as the browser can tell. */
export function isValidTargetUrl(url: string): boolean {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return false; }
	if (parsed.protocol !== 'https:') return false;
	const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
	if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false;
	return !isPrivateAddressLiteral(host);
}
