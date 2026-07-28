// === Replay provider resolution — pure, so it can be contract-tested ===
//
// Split out of `knowledge-substrate-eval.test.ts` for one reason: the resolver is
// where this harness has silently mis-measured before, and a resolver that lives
// inside a `.test.ts` cannot be imported by a test without executing the eval.
//
// The failure it exists to prevent (2026-07-27): the CLI config stores the
// Anthropic credential under `anthropic_api_key`, the resolver read only
// `api_key`, found nothing, and fell through to Mistral — while
// `LYNOX_KNOWLEDGE_MODEL` still carried an Anthropic model id. Every turn then
// 400'd into the runner's deliberate swallow-and-continue, and a full corpus
// would have reported recall 0.00 as a RESULT rather than as a misconfiguration.
// Nothing in the output said "wrong provider"; the number just looked bad.
//
// Everything here takes its inputs as arguments — no `process.env`, no `fs` — so
// the whole resolution matrix is testable without touching the machine's real
// config.

/** The Agent/judge wiring a replay run needs. Mirrors `ReplayProviderConfig`. */
export interface ResolvedReplayProvider {
  provider?: 'openai' | undefined;
  apiKey: string;
  apiBaseURL?: string | undefined;
  model: string;
  openaiModelId?: string | undefined;
}

/** Env slice the resolver reads. Explicit, so a test states exactly one world. */
export interface ReplayEnv {
  LYNOX_KNOWLEDGE_PROVIDER?: string | undefined;
  LYNOX_KNOWLEDGE_MODEL?: string | undefined;
  LYNOX_KNOWLEDGE_PROXY_URL?: string | undefined;
  LYNOX_KNOWLEDGE_PROXY_KEY?: string | undefined;
  LYNOX_KNOWLEDGE_PROXY_KEY_FILE?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  MISTRAL_API_KEY?: string | undefined;
}

/**
 * Pick a credential from an ordered list of candidates, treating empty/blank as
 * ABSENT. Extracted because the historical bug was exactly a missed candidate
 * spelling, and because "" from a half-written config must not count as a key —
 * an empty string is truthy enough to reach the API and produce a 401 that the
 * runner swallows.
 */
export function pickKey(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return undefined;
}

/** Mistral's dated stable snapshot. NEVER a `-latest` alias: those carry much
 *  lower rate limits, which grinds a long replay into 429s and reads as
 *  artificially low recall. Canonical ids live in MISTRAL_MODEL_MAP. */
export const MISTRAL_REPLAY_MODEL = 'mistral-large-2512';
/** Default for the operator-local OpenAI-wire endpoint. */
export const PROXY_DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Resolve the replay provider — PROVIDER-AGNOSTIC, so the gate runs on whatever
 * stack the operator has. Anthropic when an Anthropic key is present; otherwise
 * Mistral EU (the only path that runs on a Mistral-only box AND keeps real thread
 * content in the EU). `proxy` is explicit opt-in only and never auto-picked.
 *
 * @param readKeyFile reads `LYNOX_KNOWLEDGE_PROXY_KEY_FILE`; may throw — a
 *   set-but-unreadable key file is a MISCONFIGURATION, not "not set up".
 *   Swallowing it would resolve to null and self-skip the gate GREEN, so a typo
 *   in the path would read as a pass.
 * @param defaultAnthropicModel the model to use when no `LYNOX_KNOWLEDGE_MODEL`
 *   override is set. Passed in rather than imported so this module stays free of
 *   the online-test setup — and so a test can assert the default is APPLIED
 *   rather than an empty model id reaching the API as another swallowed 400.
 * @returns null when nothing is configured → the caller self-skips.
 */
export function resolveReplayProvider(
  env: ReplayEnv,
  cfg: Record<string, unknown>,
  readKeyFile: (path: string) => string,
  defaultAnthropicModel: string,
): ResolvedReplayProvider | null {
  const forced = env.LYNOX_KNOWLEDGE_PROVIDER;
  const modelOverride = env.LYNOX_KNOWLEDGE_MODEL;
  const fromCfg = (field: string): string | undefined => {
    const v = cfg[field];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  if (forced === 'proxy') {
    let proxyKey = pickKey(env.LYNOX_KNOWLEDGE_PROXY_KEY);
    const keyFile = env.LYNOX_KNOWLEDGE_PROXY_KEY_FILE;
    if (!proxyKey && keyFile !== undefined && keyFile.length > 0) {
      try {
        proxyKey = pickKey(readKeyFile(keyFile).trim());
      } catch (err) {
        throw new Error(`LYNOX_KNOWLEDGE_PROXY_KEY_FILE is set but unreadable (${keyFile}): ${(err as Error).message}`);
      }
    }
    const proxyUrl = pickKey(env.LYNOX_KNOWLEDGE_PROXY_URL);
    // No URL baked in: a default endpoint in a PUBLIC repo is an operator-local
    // tooling leak. Without URL *or* credential the gate self-skips.
    if (!proxyKey || !proxyUrl) return null;
    const m = modelOverride ?? PROXY_DEFAULT_MODEL;
    return { provider: 'openai', apiKey: proxyKey, apiBaseURL: proxyUrl, model: m, openaiModelId: m };
  }

  // BOTH spellings — see the header. `api_key` stays as a fallback for older
  // configs; `anthropic_api_key` is what the CLI writes today.
  const anthropicKey = pickKey(env.ANTHROPIC_API_KEY, fromCfg('anthropic_api_key'), fromCfg('api_key'));
  const mistralKey = pickKey(env.MISTRAL_API_KEY, fromCfg('mistral_api_key'));

  const useAnthropic = forced ? forced === 'anthropic' : Boolean(anthropicKey);
  if (useAnthropic && anthropicKey) {
    return { apiKey: anthropicKey, model: modelOverride ?? defaultAnthropicModel };
  }
  if (mistralKey && forced !== 'anthropic') {
    const m = modelOverride ?? MISTRAL_REPLAY_MODEL;
    return { provider: 'openai', apiKey: mistralKey, apiBaseURL: 'https://api.mistral.ai/v1', model: m, openaiModelId: m };
  }
  return null;
}
