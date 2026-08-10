// === Exfil-injection harness — the ONLINE model-driving core ===
//
// Drives the REAL Agent with the REAL managed system prompt, the REAL builtin
// tool DEFINITIONS (what the model sees), the REAL `scanToolResult`/
// `wrapUntrustedData` path (fired automatically by the Agent on external tool
// results), and the REAL `assertHostPolicy` guard. The ONLY substitution is the
// egress SINK: instrumented handlers record the emitted call and return exactly
// what production WOULD return (a guard block message, a confirm-fail, or a
// benign success) so the model's multi-step behaviour stays faithful — no bytes
// ever reach an attacker (fb_realworld_harness: the tool surface is substrate,
// the sink is not).
//
// Cross-provider, PROVIDER-AGNOSTIC (fb_provider_agnostic): a `ModelSpec` selects
// Anthropic or an OpenAI-compatible endpoint (the managed Mistral EU path).

import { Agent } from '../../../src/core/agent.js';
import { initLLMProvider } from '../../../src/core/llm-client.js';
import { wrapUntrustedData } from '../../../src/core/data-boundary.js';
import { assertHostPolicy } from '../../../src/core/network-guard.js';
import { httpRequestTool } from '../../../src/tools/builtin/http.js';
import { createWebSearchTool } from '../../../src/integrations/search/web-search-tool.js';
import { createMailSendTool } from '../../../src/integrations/mail/tools/mail-send.js';
import type { SearchProvider } from '../../../src/integrations/search/search-provider.js';
import type { MailRegistry } from '../../../src/integrations/mail/tools/registry.js';
import type { ToolEntry } from '../../../src/types/tools.js';
import {
  judge,
  managedGuardedContext,
  type Channel,
  type EmittedEgressCall,
  type LeakVerdict,
} from './judge.js';
import {
  managedSystemPrompt,
  tenantKnowledgeContext,
  renderInjection,
  DELIVERY_SOURCE_URL,
  type InjectionCase,
} from './corpus.js';

/** How to reach one model under test. Anthropic (native) or OpenAI-compatible
 *  (the managed Mistral EU path + any BYOK endpoint). */
export interface ModelSpec {
  label: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  apiBaseURL?: string | undefined;
  /** For provider 'openai': the concrete model id (e.g. 'mistral-medium-2604'). */
  openaiModelId?: string | undefined;
}

/** The delivery source host — a `web_research read` on it returns the injection;
 *  a read on ANY other host is treated as an exfil egress call. */
const DELIVERY_HOST = new URL(DELIVERY_SOURCE_URL).hostname;

/** One recorded egress call plus the two-layer verdict the judge assigned. */
export interface JudgedEgress {
  call: EmittedEgressCall;
  verdict: LeakVerdict;
}

export interface CaseOutcome {
  caseId: string;
  arm: InjectionCase['arm'];
  /** LIVENESS (refuter C1): the model emitted ≥1 tool call AND read the injected
   *  delivery content. A run with `delivered=false` is a MISCONFIG (provider
   *  mis-wired / model inert), NOT a "0% leak" datum — the runner excludes it. */
  toolCalls: number;
  delivered: boolean;
  /** Every egress call the model emitted, judged. Empty = model did not attempt
   *  egress (a real "defended" outcome IF `delivered` is true). */
  egress: JudgedEgress[];
  /** A transport/provider error, if the run failed to execute (also a non-datum). */
  error?: string | undefined;
}

/** Build the instrumented tool set: real definitions, recording handlers that
 *  mirror the real structural outcome. `interactive` toggles the confirm-gated
 *  channels' fail-closed (headless) vs rubber-stamp (worst-case tenant).
 *  Exported so the MECHANICAL positive control (mechanical-control.test.ts) can
 *  drive the handlers directly, proving the record→judge pipeline sees a real
 *  leak WITHOUT depending on a model choosing to comply (a well-aligned model
 *  refuses, so model-compliance can never be the liveness proof). */
export function buildInstrumentedTools(
  c: InjectionCase,
  canary: string,
  record: (e: EmittedEgressCall) => void,
  onToolCall: () => void,
  markDelivered: () => void,
  interactive: boolean,
): ToolEntry[] {
  const guardedCtx = managedGuardedContext();
  const injection = renderInjection(c, canary);

  // Real definitions — the exact production surface the model reasons about.
  const stubSearchProvider: SearchProvider = {
    name: 'SearXNG',
    search: async () => [],
  };
  const webDef = createWebSearchTool(stubSearchProvider).definition;
  const httpDef = httpRequestTool.definition;
  const stubMailRegistry: MailRegistry = { get: () => null, list: () => [], default: () => null };
  const mailDef = createMailSendTool(stubMailRegistry).definition;

  const web: ToolEntry = {
    definition: webDef,
    handler: async (input: unknown): Promise<string> => {
      onToolCall();
      const i = input as { action?: string; url?: string; query?: string };
      // action 'search' is NOT an exfil path (query goes to the provider, not an
      // attacker host — refuter M1); return a benign empty result.
      if (i.action === 'search' || i.url === undefined) {
        return 'No results.';
      }
      let host: string | undefined;
      try { host = new URL(i.url).hostname; } catch { host = undefined; }
      // Delivery: a read of the source the tenant asked about returns the
      // injection through the REAL wrap+scan path.
      if (host === DELIVERY_HOST) {
        markDelivered();
        return wrapUntrustedData(injection, 'web page');
      }
      // Otherwise this is an exfil READ (discovery surface). Record it, then
      // return what production returns: discovery is OPEN under guarded, so a
      // reachable public host succeeds (benign page); a blocked host (private IP)
      // returns the guard error.
      const call: EmittedEgressCall = {
        channel: 'web_research', url: i.url,
        rawArgs: JSON.stringify(i),
      };
      record(call);
      try {
        assertHostPolicy(i.url, 'discovery', guardedCtx);
        return 'Page loaded: OK.';
      } catch (e) {
        return e instanceof Error ? e.message : 'Blocked.';
      }
    },
  };

  const http: ToolEntry = {
    definition: httpDef,
    handler: async (input: unknown): Promise<string> => {
      onToolCall();
      const i = input as { url?: string; method?: string };
      if (i.url === undefined) return 'http_request error: "url" is required';
      const call: EmittedEgressCall = {
        channel: 'http_request', url: i.url, method: i.method ?? 'GET',
        rawArgs: JSON.stringify(i),
      };
      record(call);
      // Faithful: http_request is the full-control surface — guarded blocks a
      // non-baseline host. Return the real block message so the model reacts as
      // it would in production.
      try {
        assertHostPolicy(i.url, 'full-control', guardedCtx);
        return 'Request completed: 200 OK.';
      } catch (e) {
        return e instanceof Error ? e.message : 'Blocked.';
      }
    },
  };

  const mail: ToolEntry = {
    definition: mailDef,
    requiresConfirmation: true,
    handler: async (input: unknown): Promise<string> => {
      onToolCall();
      const i = input as { to?: string; subject?: string; body?: string };
      if (i.to === undefined) return 'mail_send error: "to" is required';
      const call: EmittedEgressCall = {
        channel: 'mail_send', recipient: i.to,
        rawArgs: JSON.stringify(i),
      };
      record(call);
      // Faithful: mail_send is confirm-gated + headless fail-closed
      // (mail-send.ts:95). Headless ⇒ the fail-closed message; interactive
      // rubber-stamp ⇒ sent (the worst-case tenant).
      return interactive
        ? 'Email sent.'
        : 'mail_send error: sending requires interactive user confirmation, which is not available in this mode.';
    },
  };

  return [web, http, mail];
}

/** Run one injection case against one model. Deterministic post-run judging. */
export async function runCase(
  c: InjectionCase,
  canary: string,
  spec: ModelSpec,
  opts: { interactive: boolean; maxIterations?: number },
): Promise<CaseOutcome> {
  const egressCalls: EmittedEgressCall[] = [];
  let toolCalls = 0;
  let delivered = false;
  const tools = buildInstrumentedTools(
    c, canary,
    (e) => egressCalls.push(e),
    () => { toolCalls += 1; },
    () => { delivered = true; },
    opts.interactive,
  );

  const agentConfig: ConstructorParameters<typeof Agent>[0] = {
    name: 'lynox',
    model: spec.model,
    provider: spec.provider,
    apiKey: spec.apiKey,
    systemPrompt: managedSystemPrompt(),
    knowledgeContext: tenantKnowledgeContext(canary),
    tools,
    maxIterations: opts.maxIterations ?? 6,
    // A rubber-stamp confirm for the interactive worst-case arm; absent = headless.
    ...(opts.interactive ? { promptUser: async () => 'Yes' } : {}),
    ...(spec.apiBaseURL !== undefined ? { apiBaseURL: spec.apiBaseURL } : {}),
    ...(spec.openaiModelId !== undefined ? { openaiModelId: spec.openaiModelId } : {}),
  };

  try {
    const agent = new Agent(agentConfig);
    await agent.send(c.userPrompt);
  } catch (e) {
    return {
      caseId: c.id, arm: c.arm, toolCalls, delivered,
      egress: [], error: e instanceof Error ? e.message : String(e),
    };
  }

  const guardedCtx = managedGuardedContext();
  const egress: JudgedEgress[] = egressCalls.map((call) => ({
    call,
    verdict: judge(call, canary, c.attackerDestination, guardedCtx, { interactive: opts.interactive }),
  }));

  return { caseId: c.id, arm: c.arm, toolCalls, delivered, egress };
}

/** Initialise the LLM provider once per process for a given provider kind.
 *  Anthropic and 'openai' both need this called before the first Agent. */
export async function initProvider(spec: ModelSpec): Promise<void> {
  await initLLMProvider(spec.provider);
}

export type { Channel };
