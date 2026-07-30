/**
 * Online reachability matrix: can the agent loop actually CALL TOOLS through
 * each catalog preset?
 *
 * ## Why this file exists
 *
 * `LLM_CATALOG` ships one-click presets for gateways and local runtimes (Ollama,
 * LM Studio, vLLM, LocalAI, Groq, Together, Fireworks). A preset is a promise to
 * the user: "point lynox here and it works." But lynox is an AGENT — it is
 * useless on an endpoint that streams fluent prose and then fumbles the tool
 * call, and the catalog says so itself: *"tool-calling reliability varies
 * sharply by model and endpoint."*
 *
 * A mock cannot tell us whether that promise holds. Only a real call can. (Same
 * lesson as the lazy tool-loading regression this directory already guards: the
 * deferred tools were "wired" and still unreachable on half the tiers — a green
 * mock is not a green model.)
 *
 * So `CatalogProviderEntry.verification` starts at `'experimental'` for every
 * new preset, and only a passing case HERE promotes it to `'verified'`. That
 * field is what the settings UI reads to decide whether a tile carries the
 * "unverified" caveat.
 *
 * ## What "pass" means here
 *
 * A full agentic round-trip, not a chat completion:
 *
 *   1. the model emits a `tool_use` block for the stub tool, AND
 *   2. the tool result flows back and shows up in the final answer.
 *
 * (2) matters as much as (1): a provider that emits a tool call but then cannot
 * digest the `tool_result` back into an answer breaks the loop just as badly,
 * and only an end-to-end assertion catches it.
 *
 * The stub tool returns a value the model cannot possibly guess, so a lucky
 * hallucination cannot pass. We test the MECHANISM, not the model's knowledge.
 *
 * ## Running it
 *
 * Every case self-skips unless its endpoint is reachable AND serving the model,
 * so the file is safe to run with nothing configured (it simply skips).
 *
 *   # local runtimes — free, offline, no key
 *   ollama serve & ollama pull qwen2.5:7b
 *   npx vitest run tests/online/provider-preset-reachability.test.ts
 *
 *   # remote gateways — one key each
 *   GROQ_API_KEY=… npx vitest run tests/online/provider-preset-reachability.test.ts
 *
 * Model IDs are overridable per preset (`OLLAMA_TEST_MODEL`, …) because the
 * right model is the user's choice, not ours — but the DEFAULT must be a
 * tool-capable one, or the suite would be measuring the model rather than the
 * wire.
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { Agent } from '../../src/core/agent.js';
import { createToolContext } from '../../src/core/tool-context.js';
import { LLM_CATALOG, catalogEntryKey } from '../../src/core/llm/catalog.js';
import type { ToolEntry } from '../../src/types/index.js';

/** How long we give an endpoint to say "I'm here" before skipping its case. */
const PROBE_TIMEOUT_MS = 2_000;
/** A local 7B model on CPU is slow; a remote 70B is not. Be generous. */
const CASE_TIMEOUT_MS = 180_000;

/**
 * The one number in this test. The model cannot know it, cannot derive it, and
 * cannot guess it — so the only way it reaches the final answer is through a
 * real tool_use → tool_result round-trip. That is exactly what we are asserting.
 */
const SECRET_TOTAL = 48_217;

interface PresetCase {
  /** Catalog key — the preset under test. */
  key: string;
  /** Model to drive it with. Overridable; the default must support tool use. */
  model: string;
  /**
   * API key. Loopback runtimes ignore it (but OpenAI-wire clients insist on
   * *something*), so we hand them a placeholder rather than skipping.
   */
  apiKey: string | undefined;
}

/** Env var carrying the key for each remote preset, and its default test model. */
const REMOTE_PRESETS: Record<string, { keyEnv: string; defaultModel: string }> = {
  groq:      { keyEnv: 'GROQ_API_KEY',      defaultModel: 'llama-3.3-70b-versatile' },
  together:  { keyEnv: 'TOGETHER_API_KEY',  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  fireworks: { keyEnv: 'FIREWORKS_API_KEY', defaultModel: 'accounts/fireworks/models/gpt-oss-120b' },
};

/** Default test model per loopback runtime. Each must be tool-capable. */
const LOOPBACK_DEFAULT_MODEL: Record<string, string> = {
  ollama:   'qwen2.5:7b',
  lmstudio: 'qwen2.5-7b-instruct',
  vllm:     'Qwen/Qwen2.5-7B-Instruct',
  localai:  'qwen2.5-7b-instruct',
};

const MODEL_ENV: Record<string, string> = {
  ollama:    'OLLAMA_TEST_MODEL',
  lmstudio:  'LMSTUDIO_TEST_MODEL',
  vllm:      'VLLM_TEST_MODEL',
  localai:   'LOCALAI_TEST_MODEL',
  groq:      'GROQ_TEST_MODEL',
  together:  'TOGETHER_TEST_MODEL',
  fireworks: 'FIREWORKS_TEST_MODEL',
};

/**
 * Every catalog entry that pins an endpoint and is not a native provider — i.e.
 * exactly the presets whose tool-calling is unproven. Derived from the catalog
 * rather than hand-listed, so a new preset cannot be added without this suite
 * noticing it.
 */
const PRESETS_UNDER_TEST = LLM_CATALOG.filter(
  (e) => e.base_url_default !== undefined && e.verification !== 'native',
);

/**
 * Can this case actually run? Two distinct preconditions, and conflating them
 * produces a confusing failure:
 *
 *   - is anything listening at all?  (Ollama not started → skip)
 *   - does it serve the model we intend to drive it with?
 *     (Ollama running but `qwen2.5:7b` never pulled → ALSO a skip, not a
 *     "tool-calling is broken" failure — the endpoint answers `/models` with
 *     200 and an empty list, so a naive liveness probe would sail past this and
 *     then fail deep inside the agent loop with a misleading error.)
 *
 * A missing precondition is always a SKIP. Only a reachable endpoint serving the
 * requested model may fail this suite — and then the failure means what it says:
 * tool-calling does not work here.
 */
async function preflight(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      // 401/403 proves something is THERE but wants a better key — an operator
      // configuration problem, not a wire-compatibility fact. Skip, don't fail.
      return { ok: false, reason: `endpoint returned ${res.status}` };
    }
    // Shape-tolerant: most endpoints return `{data: [...]}`, some return a bare
    // array. Anything else (a random service that happens to hold the port — the
    // LocalAI default :8080 is a popular one) is NOT an OpenAI-compatible model
    // list, and we must not point an agent at it.
    const body: unknown = await res.json();
    const raw = Array.isArray(body)
      ? body
      : (body as { data?: unknown }).data;
    if (!Array.isArray(raw)) {
      return { ok: false, reason: `no OpenAI-compatible model list at ${baseUrl}` };
    }
    const served = raw
      .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');

    // An EMPTY list is the "Ollama is running but the model was never pulled"
    // case — the exact one this preflight exists to catch. Treating it as "fine,
    // carry on" (the old `served.length > 0 &&` guard did) sails past it and then
    // fails deep inside the agent loop with a misleading error.
    if (served.length === 0) {
      return { ok: false, reason: `endpoint serves no models (is '${model}' pulled?)` };
    }
    if (!served.includes(model)) {
      return { ok: false, reason: `model '${model}' not served (has: ${served.slice(0, 3).join(', ')}…)` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `nothing listening on ${baseUrl}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stub tool whose answer cannot be guessed. Deliberately narrow and
 * unambiguous: a model that reaches for anything else has not understood the
 * task, and a model that answers without calling it has hallucinated.
 */
function buildProbeTool(calls: string[]): ToolEntry[] {
  const probe: ToolEntry = {
    definition: {
      name: 'get_open_invoice_total',
      description:
        'Returns the exact total value of all currently open (unpaid) invoices, in CHF. '
        + 'This is the ONLY way to obtain that figure — it is private business data that '
        + 'cannot be known or estimated without calling this tool.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      calls.push('get_open_invoice_total');
      return `The total value of open invoices is CHF ${SECRET_TOTAL}.`;
    },
  };
  return [probe];
}

function resolveCase(key: string): PresetCase | null {
  const remote = REMOTE_PRESETS[key];
  if (remote) {
    const apiKey = process.env[remote.keyEnv];
    if (!apiKey) return null; // no key → nothing to test
    return {
      key,
      model: process.env[MODEL_ENV[key] ?? ''] ?? remote.defaultModel,
      apiKey,
    };
  }
  const localDefault = LOOPBACK_DEFAULT_MODEL[key];
  if (!localDefault) return null; // unknown preset — the catalog grew, this map didn't
  return {
    key,
    // OpenAI-wire clients require *a* key; loopback runtimes ignore its value.
    apiKey: process.env[`${key.toUpperCase()}_API_KEY`] ?? 'local',
    model: process.env[MODEL_ENV[key] ?? ''] ?? localDefault,
  };
}

describe('provider preset reachability (real API — tool-calling round-trip)', () => {
  // A guard, not a formality: if the catalog gains a preset and nobody teaches
  // this suite about it, the preset would silently ship untested.
  it('knows about every pinned preset in the catalog', () => {
    const untested = PRESETS_UNDER_TEST
      .map(catalogEntryKey)
      .filter((k) => !(k in REMOTE_PRESETS) && !(k in LOOPBACK_DEFAULT_MODEL));
    expect(untested).toEqual([]);
  });

  for (const entry of PRESETS_UNDER_TEST) {
    const key = catalogEntryKey(entry);
    const baseUrl = entry.base_url_default!;

    it(`${key}: drives a full tool_use → tool_result → answer round-trip`, async (ctx) => {
      // `ctx.skip()`, NOT a bare `return`. A `return` reports the case as PASSED,
      // and this file is inside the default vitest include (`tests/**`), so in CI
      // — where no runtime is up and no key is set — seven green "passes" would
      // appear having touched nothing at all, while `catalog.test.ts` pins
      // `ollama` as `verified` on their supposed authority. That is precisely the
      // skip-green-is-not-pass-green trap this suite exists to prevent; it must
      // not be built into the suite itself. A skipped case must READ as skipped.
      const testCase = resolveCase(key);
      if (!testCase) {
        ctx.skip(`${key}: no API key configured`);
        return;
      }
      const pre = await preflight(baseUrl, testCase.apiKey, testCase.model);
      if (!pre.ok) {
        // A preset we claim is `verified` but cannot exercise is the dangerous
        // case: the claim outlives its evidence. Say so loudly on the way past.
        if (entry.verification === 'verified') {
          console.warn(
            `[!] ${key} is marked 'verified' in the catalog but was NOT exercised `
            + `in this run (${pre.reason}). The claim rests on an earlier run.`,
          );
        }
        ctx.skip(`${key}: ${pre.reason}`);
        return;
      }

      const calls: string[] = [];
      const agent = new Agent({
        name: `preset-${key}`,
        model: testCase.model,
        provider: entry.provider,
        apiKey: testCase.apiKey,
        apiBaseURL: baseUrl,
        openaiModelId: testCase.model,
        maxIterations: 4,
        tools: buildProbeTool(calls),
        toolContext: createToolContext({}),
        promptUser: async () => 'allow',
      });

      const answer = await agent.send(
        'How much do we currently have outstanding in open invoices? '
        + 'Give me the exact figure.',
      );

      // (1) The model reached for the tool at all.
      const toolNames = agent
        .getMessages()
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlockParam[]) : []))
        .filter((b): b is Extract<ContentBlockParam, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => b.name);

      expect(toolNames, `${key} never emitted a tool_use block`).toContain('get_open_invoice_total');
      expect(calls, `${key} emitted a tool_use but the handler never ran`).toContain('get_open_invoice_total');

      // (2) The tool RESULT made it back into the answer. A provider that can
      //     call a tool but cannot digest the result breaks the agent loop just
      //     as thoroughly — and only this half of the assertion catches it.
      //     Digits-only so `48'217` / `48,217` / `48217` all count; the model may
      //     format the figure however it likes, it just has to have SEEN it.
      const digits = answer.replace(/[^0-9]/g, '');
      expect(
        digits.includes(String(SECRET_TOTAL)),
        `${key} called the tool but the result never reached the answer. Got: ${answer.slice(0, 200)}`,
      ).toBe(true);
    }, CASE_TIMEOUT_MS);
  }
});
