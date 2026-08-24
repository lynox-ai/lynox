/**
 * Who asked. A confirmation raised from inside a workflow step has no visible
 * cause in the transcript — the step's tool calls never enter it — so the engine
 * ships the origin on the prompt itself and the dialog renders it.
 *
 * Lives here rather than in `chat.svelte.ts` so it can be tested: that module is
 * a Svelte rune file and the root vitest config carries no svelte plugin, so
 * importing it throws `$state is not defined`.
 */

export interface PromptOrigin {
	workflowName?: string;
	stepId?: string;
	stepTask?: string;
	/**
	 * ⭐ The FACT that a spawned sub-agent raised this prompt. The engine sets it;
	 * nothing a model writes can produce or suppress it.
	 *
	 * It is separate from the name below because the first version keyed the
	 * claim on the name — and a name of one zero-width space survives the
	 * engine's validation and cleans down to empty here, so a parent could delete
	 * the very line that warns about it. A boolean cannot be emptied.
	 */
	subagent?: true;
	/**
	 * The sub-agent's name and task: DECORATION on the fact above. Both are
	 * written by the model that spawned it — by the agent this line exists to
	 * make the user look twice at — so neither may carry the warning. They are
	 * rendered as values inside a frame the renderer owns, and the frame renders
	 * with or without them.
	 */
	subagentName?: string;
	subagentTask?: string;
}

/**
 * A workflow name and a step id come from a manifest, and a manifest can be
 * model-authored: `validateManifest` requires `min(1)` and imposes no ceiling.
 * This label sits directly above Allow/Deny, so an unbounded string would push
 * the buttons out of the viewport — and "the user cannot see what they are
 * agreeing to" is the actual failure this whole feature exists to prevent.
 */
const MAX_LABEL = 80;
/** The task is prose on its own line, so it may run longer than a label. */
const MAX_TASK = 160;

/**
 * C0/C1 controls — a newline would turn one label into several lines — plus
 * U+2028/U+2029, which browsers break lines on exactly like `\n` and which no
 * control-character range covers. `chat-framing.ts` strips them for the same
 * reason and says so; this file did not, and the origin block has no height cap
 * while the question body below it does — so it is the one part of the dialog
 * that can push Allow/Deny off screen.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
/**
 * Bidi marks and overrides — they render text in an order it is not written in —
 * plus the zero-width formatters, which fill a label that looks empty. This
 * field is a workflow label and never a person's name, so unlike the shared
 * `sanitizeFramingField` it can afford to drop LRM/RLM as well.
 */
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

/**
 * Strip what can forge a label rather than fill it, then bound the length.
 *
 * This does NOT try to defeat lookalike quotes — a name containing
 * `" - Schritt "` can still read like two fields. That is handled where it
 * belongs: the renderer puts the workflow and the step in SEPARATE elements, so
 * the separator between them is structure the content cannot reach, not
 * punctuation it can imitate.
 */
function clean(value: string, max: number): string {
	const stripped = value.replace(CONTROL_CHARS, '').replace(BIDI_CHARS, '').trim();
	if (stripped.length <= max) return stripped;
	// Cut on CODE POINTS, not UTF-16 units: `slice` on a string whose (max-1)th
	// unit is a lead surrogate splits the pair and leaves a lone half, which
	// renders as U+FFFD. An emoji in a workflow name is ordinary, not exotic.
	return `${[...stripped].slice(0, max - 1).join('')}…`;
}

/**
 * Every origin field in ONE table: its wire name and how far it may run.
 *
 * `satisfies Record<keyof PromptOrigin, …>` is exhaustive, so a field added to
 * the interface and not here does not compile — and both readers below derive
 * from it, so the live-event path and the resume path cannot come to know
 * different sets of fields. They did not before; they would have the first time
 * someone added a field to one of two hand-written argument lists.
 */
const ORIGIN_FIELDS = {
	workflowName: { wire: 'workflow_name', max: MAX_LABEL },
	stepId: { wire: 'step_id', max: MAX_LABEL },
	stepTask: { wire: 'step_task', max: MAX_TASK },
	// A flag, not text: it carries no `max` because there is nothing to clamp,
	// and it is read below by its own branch rather than by the cleaning loop.
	subagent: { wire: 'subagent' },
	subagentName: { wire: 'subagent_name', max: MAX_LABEL },
	subagentTask: { wire: 'subagent_task', max: MAX_TASK },
} satisfies Record<keyof PromptOrigin, { wire: string; max?: number }>;

const ORIGIN_KEYS = Object.keys(ORIGIN_FIELDS) as (keyof PromptOrigin)[];

/** The text fields — everything with a length to clamp. */
const TEXT_KEYS = ORIGIN_KEYS.filter(
	(key): key is Exclude<keyof PromptOrigin, 'subagent'> => 'max' in ORIGIN_FIELDS[key],
);

/**
 * Build an origin from loosely-typed fields, or `undefined` when none of them
 * carries anything. Empty counts as absent: a prompt with no origin must render
 * NO origin line, and an empty frame is worse than none — it claims someone
 * asked and then fails to name them. A value that is nothing BUT control
 * characters cleans down to empty and is therefore absent too.
 *
 * Takes a record rather than one argument per field so a caller cannot pass
 * some of them and silently drop the rest — the failure a positional list
 * invites the moment a sixth field arrives.
 */
export function toPromptOrigin(raw: Partial<Record<keyof PromptOrigin, unknown>>): PromptOrigin | undefined {
	const o: PromptOrigin = {};
	let present = false;
	for (const key of TEXT_KEYS) {
		const value = raw[key];
		if (typeof value !== 'string') continue;
		const cleaned = clean(value, ORIGIN_FIELDS[key].max);
		if (!cleaned) continue;
		o[key] = cleaned;
		present = true;
	}
	// The flag survives a name that cleans away to nothing — which is the whole
	// reason it exists, so it is checked on its own and never through `cleaned`.
	if (raw.subagent === true) { o.subagent = true; present = true; }
	return present ? o : undefined;
}

/** Read one shape into the other, by a key function over the same table. */
function pick(data: Record<string, unknown>, keyOf: (key: keyof PromptOrigin) => string): PromptOrigin | undefined {
	const raw: Partial<Record<keyof PromptOrigin, unknown>> = {};
	for (const key of ORIGIN_KEYS) raw[key] = data[keyOf(key)];
	return toPromptOrigin(raw);
}

/** Origin off a live SSE prompt event — flat, snake_case wire fields. */
export function originFromEvent(data: Record<string, unknown>): PromptOrigin | undefined {
	return pick(data, key => ORIGIN_FIELDS[key].wire);
}

/** Origin off `GET /pending-prompt` — the nested object persisted in v52. */
export function originFromPending(raw: unknown): PromptOrigin | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	return pick(raw as Record<string, unknown>, key => key);
}
