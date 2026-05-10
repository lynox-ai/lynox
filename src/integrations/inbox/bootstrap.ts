// === Inbox bootstrap — assembles the Phase-1a runtime ===
//
// One factory that the Engine calls during init. Builds the dependency
// graph in the right order (budget before LLM caller before queue) and
// returns an `InboxRuntime` bundle that the Engine stores, drains on
// shutdown, and exposes via getInboxRuntime().
//
// Each constituent module is independently tested; this file's
// responsibility is the wiring order and the closure that connects the
// LLM caller's `onUsage` hook to the budget's `recordUsage`.

import type Anthropic from '@anthropic-ai/sdk';
import type { CRM } from '../../core/crm.js';
import { getModelId } from '../../types/index.js';
import type { LLMCaller } from './classifier/index.js';
import {
  type AnthropicLike,
  wrapAnthropicAsLLMCaller,
} from './classifier/llm.js';
import { createMistralEuLLMCaller } from './classifier/llm-mistral.js';
import { type ClassifierQueue } from './classifier/queue.js';
import { InboxContactResolver } from './contact-resolver.js';
import { InboxCostBudget, type InboxCostBudgetOptions } from './cost-budget.js';
import { InboxRulesLoader } from './rules-loader.js';
import {
  buildInboxRunner,
  type InboxQueuePayload,
  type InboxRunnerPolicy,
} from './runner.js';
import { InboxStateDb } from './state.js';
import type { SensitiveMode } from './sensitive-content.js';
import {
  type AccountResolver,
  createInboxClassifierHook,
  type OnInboundMailHook,
} from './watcher-hook.js';
import type { MailStateDb } from '../mail/state.js';

/** Bundle the Engine retains. `shutdown()` drains the queue. */
export interface InboxRuntime {
  state: InboxStateDb;
  rules: InboxRulesLoader;
  contactResolver: InboxContactResolver | null;
  budget: InboxCostBudget;
  queue: ClassifierQueue<InboxQueuePayload>;
  /** Wire as `MailHooks.onInboundMail` after MailContext construction. */
  hook: OnInboundMailHook;
  shutdown(): Promise<void>;
}

export interface BootstrapInboxOptions {
  /** Mail state DB whose connection (post-migration v7) we share. */
  mailStateDb: MailStateDb;
  /** Anthropic-shaped client — typically `engine.client`. Used when llmFactory is not set. */
  anthropicClient: Anthropic;
  /** CRM enables sender enrichment via the contact resolver. */
  crm?: CRM | null | undefined;
  /** Override the daily budget (Infinity disables the circuit-breaker). */
  budget?: InboxCostBudgetOptions | undefined;
  /** Override queue concurrency / timeout policy. */
  policy?: InboxRunnerPolicy | undefined;
  /** Pin a specific Haiku variant — defaults to `getModelId('haiku')`. */
  modelIdOverride?: string | undefined;
  /** Single-tenant scope; defaults to InboxStateDb's `'default'` sentinel. */
  tenantId?: string | undefined;
  /**
   * How to handle mails the sensitive-content detector flags. Default is
   * `'skip'` (block + audit, never reaches the LLM). Override via the env
   * `LYNOX_INBOX_SENSITIVE_MODE` (engine wiring reads + forwards).
   */
  sensitiveMode?: SensitiveMode | undefined;
  /**
   * EU-residency switch. When 'eu', the runtime uses Mistral via
   * createMistralEuLLMCaller — no mail content leaves the EU. Default
   * 'us' uses the Haiku/Anthropic path.
   *
   * When 'eu', `mistralApiKey` is required (engine wiring reads it from
   * the secret store).
   */
  llmRegion?: 'us' | 'eu' | undefined;
  mistralApiKey?: string | undefined;
}

export function bootstrapInbox(opts: BootstrapInboxOptions): InboxRuntime {
  const state = new InboxStateDb(opts.mailStateDb.getConnection());
  const rules = new InboxRulesLoader(state);
  const contactResolver = opts.crm ? new InboxContactResolver(opts.crm) : null;
  const budget = new InboxCostBudget(opts.budget ?? {});

  const onUsage = (usage: { inputTokens: number; outputTokens: number }): void => {
    budget.recordUsage(usage.inputTokens, usage.outputTokens);
  };
  let llm: LLMCaller;
  if (opts.llmRegion === 'eu') {
    if (!opts.mistralApiKey) {
      throw new Error('bootstrapInbox: llmRegion=eu requires mistralApiKey');
    }
    const mistralOpts: Parameters<typeof createMistralEuLLMCaller>[0] = {
      apiKey: opts.mistralApiKey,
      onUsage,
    };
    if (opts.modelIdOverride !== undefined) mistralOpts.modelId = opts.modelIdOverride;
    llm = createMistralEuLLMCaller(mistralOpts);
  } else {
    llm = wrapAnthropicAsLLMCaller(
      opts.anthropicClient as unknown as AnthropicLike,
      opts.modelIdOverride ?? getModelId('haiku'),
      { onUsage },
    );
  }

  const queue = buildInboxRunner({
    state,
    llm,
    budget,
    policy: opts.policy,
  });

  const accounts: AccountResolver = {
    resolve: (id) => {
      const acct = opts.mailStateDb.getAccount(id);
      return acct ? { address: acct.address, displayName: acct.displayName } : null;
    },
  };

  const hook = createInboxClassifierHook({
    state,
    rules,
    queue,
    accounts,
    tenantId: opts.tenantId,
    sensitiveMode: opts.sensitiveMode,
  });

  return {
    state,
    rules,
    contactResolver,
    budget,
    queue,
    hook,
    shutdown: () => queue.drain(),
  };
}
