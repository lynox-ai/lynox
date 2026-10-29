/**
 * The owner's stamp of a workflow a mandate built or changed (register 242 (c)): what the
 * library shows, and what the answers of the two stamp routes mean.
 *
 * `GET /api/workflows/:id/stamp-preview` says what would run and returns the digest of exactly
 * that (`expect`). `POST /api/workflows/:id/confirm` takes the digest back and stamps only if the
 * workflow is still what was shown. A refusal is read by its `code`, never by its message: the
 * view words each code itself.
 *
 * A module and not inline in the view for the reason `run-notice.ts` records: a Svelte component
 * cannot be imported in vitest here, so every decision the view takes has to be drivable from a
 * test, not witnessed by a regex over the component's text.
 */

export interface StampStep {
  id: string;
  task: string;
  /** A recorded step's literal call; `inputTemplate` keeps its `{{params.x}}` placeholders. */
  tool: string | null;
  inputTemplate: unknown;
  /** The effective tool set, not only what the definition names. */
  tools: string[];
  model: string | null;
  inputFrom: string[];
}

export interface StampParameter {
  name: string;
  required: boolean;
  default: unknown;
}

export interface StampPreview {
  expect: string;
  stampedAt: string | null;
  changedBy: 'mandate' | 'owner' | null;
  awaitsStamp: boolean;
  mode: string | null;
  parameters: StampParameter[];
  onFailure: string | null;
  limits: unknown;
  /** The contract tuples, one line per (method, URL), or null without a contract. */
  contract: string[] | null;
  steps: StampStep[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Marks a value that is present but not of its type, so the whole preview is refused. */
const BAD = Symbol('bad');
/** Absent or null is "none"; a string is itself; anything else is BAD. */
const optStr = (v: unknown): string | null | typeof BAD => (v === undefined || v === null ? null : typeof v === 'string' ? v : BAD);
/** Absent or null is the empty list; an array of strings is itself; anything else, or any non-string entry, is BAD. */
const optStrings = (v: unknown): string[] | typeof BAD => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return BAD;
  return v as string[];
};

/**
 * The preview as the view may show it, or null for an answer that is not one.
 *
 * ⚠ Null on anything it cannot read whole, and null means "offer no stamp": a stamp sent with a
 * digest over a list the view did not render would confirm steps the owner was not shown. So a step
 * it cannot read makes the whole preview unreadable — dropping it would hide exactly the step that
 * differs — and so does a field that decides what runs (a step's call, its tools, the contract, a
 * parameter) when it is present but not of its type: read leniently, it would be shown as "none".
 * Only absent or null means none.
 */
export function parseStampPreview(body: unknown): StampPreview | null {
  if (!isRecord(body) || typeof body['expect'] !== 'string' || body['expect'] === '') return null;
  if (!Array.isArray(body['steps'])) return null;
  const steps: StampStep[] = [];
  for (const s of body['steps']) {
    if (!isRecord(s) || typeof s['id'] !== 'string' || typeof s['task'] !== 'string') return null;
    const tool = optStr(s['tool']);
    const tools = optStrings(s['tools']);
    const model = optStr(s['model']);
    const inputFrom = optStrings(s['inputFrom']);
    if (tool === BAD || tools === BAD || model === BAD || inputFrom === BAD) return null;
    const inputTemplate = s['inputTemplate'] ?? null;
    // A call's input without the call: the view prints the input under the tool, so it would vanish.
    if (inputTemplate !== null && tool === null) return null;
    steps.push({ id: s['id'], task: s['task'], tool, inputTemplate, tools, model, inputFrom });
  }
  const contract = body['contract'] === undefined || body['contract'] === null ? null : optStrings(body['contract']);
  if (contract === BAD) return null;
  const rawParams = body['parameters'] ?? [];
  if (!Array.isArray(rawParams)) return null;
  const parameters: StampParameter[] = [];
  for (const p of rawParams) {
    if (!isRecord(p) || typeof p['name'] !== 'string') return null;
    parameters.push({ name: p['name'], required: p['required'] === true, default: p['default'] ?? null });
  }
  const mode = optStr(body['mode']);
  const onFailure = optStr(body['onFailure']);
  const stampedAt = optStr(body['stampedAt']);
  if (mode === BAD || onFailure === BAD || stampedAt === BAD) return null;
  const changedBy = body['changedBy'];
  return {
    expect: body['expect'],
    stampedAt,
    changedBy: changedBy === 'mandate' || changedBy === 'owner' ? changedBy : null,
    awaitsStamp: body['awaitsStamp'] === true,
    mode,
    parameters,
    onFailure,
    limits: body['limits'] ?? null,
    contract,
    steps,
  };
}

/**
 * Characters that change how text reads without being seen — direction overrides and isolates,
 * zero-width characters — printed as their code point instead. The view's threat is the helper who
 * wrote the steps: a host written with U+202E reads reversed, so another host looks familiar.
 */
// Tag characters (U+E0000–E007F) are invisible when rendered but read by a model: text hidden in a
// harmless task. Variation selectors (U+FE00–FE0F, U+E0100–E01EF) can carry data the same way.
// Whole code points (`u`), so the astral ranges match.
const HIDDEN = /[\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
export function visible(text: string): string {
  return text.replace(HIDDEN, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** How long the start of a step's task text runs in the step's heading (there is no step name). */
export const STEP_TASK_HEAD = 80;

/** The heading of a step: its id and the start of its task text, cut on a whole character. */
export function stepHeading(step: { id: string; task: string }): { id: string; head: string } {
  const flat = step.task.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return { id: visible(step.id), head: visible(chars.length > STEP_TASK_HEAD ? `${chars.slice(0, STEP_TASK_HEAD).join('')}…` : flat) };
}

/** A recorded step's input template as the view prints it: the literal call, nothing hidden. */
export function templateText(template: unknown): string {
  if (template === null || template === undefined) return '';
  return visible(typeof template === 'string' ? template : JSON.stringify(template, null, 2));
}

/** Whether the library offers the owner the stamp of this workflow. */
export function offersStamp(wf: { awaitsStamp?: boolean | undefined }, viewer: string | undefined): boolean {
  return wf.awaitsStamp === true && viewer === 'owner';
}

export type ConfirmOutcome =
  | { kind: 'stamped' }
  /** The steps changed since they were shown: the view loads the new version and asks again. */
  | { kind: 'changed' }
  | { kind: 'failed'; key: string };

/**
 * What an answer of `POST /api/workflows/:id/confirm` means for the view.
 *
 * Only a 2xx stamps. `steps_changed` is the one refusal with a way forward inside the view; every
 * other answer, including a 409 with another code or none, is a failure — never read as "stamped".
 */
export function confirmOutcome(status: number, code: string | undefined): ConfirmOutcome {
  if (status >= 200 && status < 300) return { kind: 'stamped' };
  if (status === 409 && code === 'steps_changed') return { kind: 'changed' };
  return { kind: 'failed', key: 'common.save_failed' };
}

/**
 * Whether a refused schedule is refused because its workflow waits for the owner's stamp, and
 * which workflow: the view then opens that workflow's stamp view in place of the schedule dialog.
 * The `pipelineId` must be the workflow being scheduled — a refusal naming another one is not
 * this one's way out.
 */
export function awaitsStampRefusal(status: number, body: unknown, pipelineId: string): boolean {
  return status === 409 && isRecord(body) && body['code'] === 'workflow_awaits_stamp' && body['pipelineId'] === pipelineId;
}
