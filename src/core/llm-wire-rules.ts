/**
 * Per-model request shaping at the Anthropic client boundary.
 *
 * Some models reject request fields that others accept — a forced `tool_choice`, an
 * explicit `thinking: {type: 'disabled'}`, a non-default `temperature` — each with a
 * 400. The rules live on the model's capability entry (`ModelCapability.wireRules`)
 * and are applied HERE, once, for every request every client sends, instead of at the
 * dozen call sites that build requests. A new caller or a new model therefore cannot
 * reintroduce a field the model refuses: the rule follows the model id, not the code
 * path. `createLLMClient` wraps every Anthropic and Vertex client it builds.
 *
 * The one rewrite that changes behaviour is the forced tool. With `auto` the model may
 * answer without calling the tool, so the boundary checks the reply and throws
 * {@link ForcedToolNotCalledError} — carrying the whole response, usage included —
 * instead of handing the caller a reply its parser reads as "nothing extracted". The
 * caller takes the reply back with {@link settleForcedTool}, books its spend exactly once,
 * and then reports the miss with {@link reportForcedToolMiss}.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { modelCapability } from '../types/models.js';

/** What the caller forced before the boundary relaxed it to `auto`. */
export type ForcedTool = { type: 'tool'; name: string } | { type: 'any' };

/**
 * The model answered a request whose forced `tool_choice` the boundary had to relax,
 * and did not call the tool. Named so a caller can tell it from a transport failure,
 * and carrying the response so the tokens it cost are not lost with the exception.
 */
export class ForcedToolNotCalledError extends Error {
  override readonly name = 'ForcedToolNotCalledError';
  /** The token counts the reply cost — what the caller books. */
  readonly usage: unknown;
  /**
   * The full reply. NON-enumerable on purpose: its text is model output written from
   * the user's conversation, and an error object travels into logs and error reports,
   * whose serialisers walk enumerable fields. Read it deliberately, never by accident.
   */
  declare readonly response: { content: ReadonlyArray<{ type: string; name?: string }>; usage?: unknown };

  constructor(
    readonly model: string,
    readonly forced: ForcedTool,
    response: { content: ReadonlyArray<{ type: string; name?: string }>; usage?: unknown },
  ) {
    // The message names the model and the tool, never the reply's content.
    super(
      forced.type === 'tool'
        ? `${model} answered without calling the required tool "${forced.name}"`
        : `${model} answered without calling any of the provided tools`,
    );
    this.usage = response.usage;
    Object.defineProperty(this, 'response', { value: response, enumerable: false, writable: false });
  }
}

type Params = Record<string, unknown>;

const SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k'] as const;

/** The sentence appended to `system` when a forced choice is relaxed to `auto`. */
export function forcedToolInstruction(forced: ForcedTool): string {
  return forced.type === 'tool'
    ? `Answer by calling the \`${forced.name}\` tool. Do not reply in text.`
    : 'Answer by calling one of the provided tools. Do not reply in text.';
}

function appendSystem(system: unknown, text: string): unknown {
  if (system === undefined || system === '') return text;
  if (typeof system === 'string') return `${system}\n\n${text}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text }];
  return system;
}

/**
 * Rewrite `params` to what `params.model` accepts. Pure: the input is not mutated, and a
 * model without rules gets the very same object back. Returns the forced tool the
 * caller asked for when it had to be relaxed, so the reply can be checked against it.
 */
export function shapeRequestForModel<P extends Params>(params: P): { params: P; forced: ForcedTool | undefined } {
  const model = typeof params['model'] === 'string' ? params['model'] : undefined;
  const rules = model === undefined ? undefined : modelCapability(model)?.wireRules;
  if (!rules) return { params, forced: undefined };

  const out: Params = { ...params };
  let forced: ForcedTool | undefined;

  if (rules.samplingParams === 'rejected') {
    for (const f of SAMPLING_FIELDS) delete out[f];
  }

  const thinking = out['thinking'] as { type?: unknown } | undefined;
  if (rules.thinkingDisabled && thinking?.type === 'disabled') {
    if (rules.thinkingDisabled === 'omit') delete out['thinking'];
    else out['thinking'] = { type: 'between_tools' };
  }

  const choice = out['tool_choice'] as { type?: unknown; name?: unknown; disable_parallel_tool_use?: unknown } | undefined;
  if (rules.forcedToolChoice === 'rejected' && (choice?.type === 'tool' || choice?.type === 'any')) {
    forced = choice.type === 'tool' && typeof choice.name === 'string'
      ? { type: 'tool', name: choice.name }
      : { type: 'any' };
    out['tool_choice'] = choice.disable_parallel_tool_use === undefined
      ? { type: 'auto' }
      : { type: 'auto', disable_parallel_tool_use: choice.disable_parallel_tool_use };
    out['system'] = appendSystem(out['system'], forcedToolInstruction(forced));
  }

  return { params: out as P, forced };
}

/** Throw {@link ForcedToolNotCalledError} when the reply lacks the call `forced` required. */
export function assertForcedToolCalled(
  model: string,
  forced: ForcedTool,
  response: { content: ReadonlyArray<{ type: string; name?: string }>; usage?: unknown },
): void {
  const called = response.content.some((b) =>
    b.type === 'tool_use' && (forced.type === 'any' || b.name === forced.name));
  if (!called) throw new ForcedToolNotCalledError(model, forced, response);
}

const SHAPED = Symbol.for('lynox.wireRulesShaped');

/** Whether `client` already routes its requests through {@link shapeRequestForModel}. */
export function isWireShaped(client: unknown): boolean {
  return typeof client === 'object' && client !== null && (client as Record<symbol, unknown>)[SHAPED] === true;
}

type Fn = (params: Params, ...rest: unknown[]) => unknown;
type Reply = { content: ReadonlyArray<{ type: string; name?: string }> };

/**
 * Replace `surface[key]` with a Proxy around the original method. A Proxy, not a new
 * function, so everything else the original carries (a test double's call record, SDK
 * properties) stays readable through it.
 */
function intercept(surface: Record<string, unknown>, key: string, call: (orig: Fn, thisArg: unknown, params: Params, rest: unknown[]) => unknown): void {
  const orig = surface[key];
  if (typeof orig !== 'function') return;
  surface[key] = new Proxy(orig as Fn, {
    apply(target, thisArg, args: unknown[]) {
      const [params, ...rest] = args;
      const bound: Fn = (p, ...r) => Reflect.apply(target, thisArg, [p, ...r]);
      return call(bound, thisArg, (params ?? {}) as Params, rest);
    },
  });
}

/** Wrap one `messages`-like surface: create, stream, countTokens. */
function wrapMessages(surface: Record<string, unknown> | undefined): void {
  if (!surface) return;

  intercept(surface, 'create', (orig, _this, params, rest) => {
    const { params: shaped, forced } = shapeRequestForModel(params);
    const result = orig(shaped, ...rest);
    // A streaming create returns a stream, not a message; the stream() wrapper is the
    // checked path for streams. No caller forces a tool through stream:true, and the
    // forcing-sites test in llm-wire-rules.test.ts fails if one starts to.
    if (!forced || shaped['stream'] === true) return result;
    return (result as Promise<Reply>).then((msg) => {
      assertForcedToolCalled(String(shaped['model']), forced, msg);
      return msg;
    });
  });

  intercept(surface, 'stream', (orig, _this, params, rest) => {
    const { params: shaped, forced } = shapeRequestForModel(params);
    const s = orig(shaped, ...rest) as { finalMessage?: () => Promise<Reply> } | undefined;
    if (forced && s && typeof s.finalMessage === 'function') {
      const final = s.finalMessage.bind(s);
      s.finalMessage = async () => {
        const msg = await final();
        assertForcedToolCalled(String(shaped['model']), forced, msg);
        return msg;
      };
    }
    return s;
  });

  // Token counting rejects the same fields (the forced choice included), but has no
  // reply to check.
  intercept(surface, 'countTokens', (orig, _this, params, rest) => orig(shapeRequestForModel(params).params, ...rest));
}

/**
 * Route every request `client` sends through {@link shapeRequestForModel}. Idempotent.
 * Covers `messages` and `beta.messages`, the two surfaces callers use.
 */
export function withWireRules<C extends Anthropic>(client: C): C {
  if (isWireShaped(client)) return client;
  const c = client as unknown as Record<string, unknown> & { beta?: Record<string, unknown> };
  wrapMessages(c['messages'] as Record<string, unknown> | undefined);
  wrapMessages(c.beta?.['messages'] as Record<string, unknown> | undefined);
  Object.defineProperty(client, SHAPED, { value: true, enumerable: false });
  return client;
}

/** Misses per call site since process start — the Stage-1 measure of how often `auto` loses the call. */
const forcedToolMisses = new Map<string, number>();

/** A copy of the per-site miss counts. */
export function forcedToolMissCounts(): Record<string, number> {
  return Object.fromEntries(forcedToolMisses);
}

/**
 * Await a reply that may end in {@link ForcedToolNotCalledError}, and hand the reply back
 * either way.
 *
 * ⛔ WHY IT RETURNS INSTEAD OF RETHROWING: every caller books the reply's tokens right after
 * it awaits, and then branches on "no tool_use". A throw would skip the booking — the tokens
 * were spent, the tenant would not be charged — and skip whatever the no-call branch reports.
 * So the miss comes back as a reply with no tool call, the caller's own booking runs exactly
 * once on it, and `missed` lets the caller say what happened afterwards
 * ({@link reportForcedToolMiss}). Any other error still throws.
 */
export async function settleForcedTool<M>(reply: Promise<M>): Promise<{ message: M; missed: ForcedToolNotCalledError | undefined }> {
  try {
    return { message: await reply, missed: undefined };
  } catch (err) {
    if (err instanceof ForcedToolNotCalledError) return { message: err.response as unknown as M, missed: err };
    throw err;
  }
}

/**
 * Say, by name, that a forced tool call was lost. Counts per call site and writes one line
 * to stderr; never throws, because every caller runs it on a fail-soft path. Call it AFTER
 * the reply's cost is booked. The line carries model, tool and site only — never reply text.
 */
export function reportForcedToolMiss(site: string, missed: ForcedToolNotCalledError | undefined): void {
  if (!missed) return;
  try {
    forcedToolMisses.set(site, (forcedToolMisses.get(site) ?? 0) + 1);
    process.stderr.write(`[wire] ${site}: ${missed.message}\n`);
  } catch {
    // Reporting must not take a caller down.
  }
}
