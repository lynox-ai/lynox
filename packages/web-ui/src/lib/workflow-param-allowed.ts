/**
 * What a saved workflow's contract lets a parameter take, for the run and schedule forms: its allowed
 * values and its bounds. Read from the contract the library already sends, and shown to the owner
 * only: a refusal no longer lists the allowed values (it reaches the model too), so the form is
 * where the owner sees them. Values are text for the form, each once; anything not a string or a
 * finite number is left out.
 */
export interface ParamAllowed {
	values?: string[];
	min?: number;
	max?: number;
}

export function paramAllowed(contract: unknown, name: string, ownerView: boolean): ParamAllowed | null {
	if (!ownerView || contract === null || typeof contract !== 'object') return null;
	const constraints = (contract as { paramConstraints?: unknown }).paramConstraints;
	if (constraints === null || typeof constraints !== 'object' || !Object.hasOwn(constraints, name)) return null;
	const c = (constraints as Record<string, unknown>)[name];
	if (c === null || typeof c !== 'object') return null;
	const { enum: values, min, max } = c as { enum?: unknown; min?: unknown; max?: unknown };
	const out: ParamAllowed = {};
	if (Array.isArray(values)) {
		const shown = [...new Set(values.flatMap((v) => (typeof v === 'string' ? [v] : typeof v === 'number' && Number.isFinite(v) ? [String(v)] : [])))];
		if (shown.length > 0) out.values = shown;
	}
	if (typeof min === 'number' && Number.isFinite(min)) out.min = min;
	if (typeof max === 'number' && Number.isFinite(max)) out.max = max;
	return Object.keys(out).length === 0 ? null : out;
}
