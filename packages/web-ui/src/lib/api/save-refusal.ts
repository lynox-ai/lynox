// === Why a settings save was refused ===
//
// The server answers a refused `PUT /api/config` with a sentence in `error`: "Only the owner
// of this instance can change the configuration", a field a managed instance locks, a value
// that fails validation. Most settings pages threw `HTTP ${res.status}` or a bare Error and
// showed "HTTP 403" or "Save failed", so the person never learned that the setting is the
// owner's, or which field was wrong. Every save goes through `throwIfRefused`, and a test
// finds any `PUT` on `/config` that does not.

/** A save the server refused. `reason` is the sentence it sent, or null when it sent none. */
export class SaveRefused extends Error {
	readonly reason: string | null;
	readonly status: number;

	constructor(reason: string | null, status: number) {
		super(reason ?? `HTTP ${status}`);
		this.name = 'SaveRefused';
		this.reason = reason;
		this.status = status;
	}
}

/** Throws `SaveRefused` when the answer is not ok, carrying the server's `error` sentence. */
export async function throwIfRefused(res: Response): Promise<void> {
	if (res.ok) return;
	let reason: string | null = null;
	try {
		const body: unknown = await res.json();
		if (body !== null && typeof body === 'object' && 'error' in body) {
			const error = (body as { error: unknown }).error;
			if (typeof error === 'string' && error.trim() !== '') reason = error.trim();
		}
	} catch {
		// Not JSON: there is no sentence to show, only the status.
	}
	throw new SaveRefused(reason, res.status);
}

/** The text for a failed save: the server's sentence when it sent one, else `fallback`. */
export function saveFailedText(e: unknown, fallback: string): string {
	return e instanceof SaveRefused && e.reason !== null ? e.reason : fallback;
}
