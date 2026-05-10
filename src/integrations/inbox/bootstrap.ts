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
  /** Folder names whose mails skip the inbox entirely. */
  folderBlacklist?: ReadonlySet<string> | undefined;
  /** Account ids whose mails skip the inbox entirely. */
  disabledAccounts?: ReadonlySet<string> | undefined;
  /**
   * When `llmRegion='us'` and this is true, bootstrap throws unless the
   * caller has confirmed via `privacyAck=true` that the operator agreed
   * to mail content leaving the EU. Engine wiring sets `requireUsAck`
   * from `LYNOX_INBOX_REQUIRE_PRIVACY_ACK=1` and `privacyAck` from
   * `LYNOX_INBOX_PRIVACY_ACK=1`.
   */
  requireUsAck?: boolean | undefined;
  privacyAck?: boolean | undefined;
}

export function bootstrapInbox(opts: BootstrapInboxOptions): InboxRuntime {
  const region = opts.llmRegion ?? 'us';
  // Hard-fail when the operator opted into ack-enforcement but did not
  // ack the US routing — the only safe production posture is explicit.
  if (region === 'us' && opts.requireUsAck && !opts.privacyAck) {
    throw new Error(
      'bootstrapInbox: LYNOX_INBOX_LLM_REGION defaults to US (Anthropic). '
      + 'Production-gating is on (LYNOX_INBOX_REQUIRE_PRIVACY_ACK=1) but '
      + 'LYNOX_INBOX_PRIVACY_ACK=1 is not set. Either set the ack or '
      + 'switch to LYNOX_INBOX_LLM_REGION=eu (Mistral).',
    );
  }
  // Always emit a non-fatal warning so operators see the residency
  // implication when the flag flips on with default routing.
  if (region === 'us' && !opts.privacyAck) {
    console.warn(
      '[lynox] Inbox classifier routes via Anthropic US — mail snippets '
      + 'leave the EU. Set LYNOX_INBOX_LLM_REGION=eu (Mistral) for '
      + 'EU residency, or LYNOX_INBOX_PRIVACY_ACK=1 to silence this warning.',
    );
  }

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

  const hookOpts: Parameters<typeof createInboxClassifierHook>[0] = {
    state,
    rules,
    queue,
    accounts,
    tenantId: opts.tenantId,
    sensitiveMode: opts.sensitiveMode,
  };
  if (opts.folderBlacklist !== undefined) hookOpts.folderBlacklist = opts.folderBlacklist;
  if (opts.disabledAccounts !== undefined) hookOpts.disabledAccounts = opts.disabledAccounts;
  const hook = createInboxClassifierHook(hookOpts);

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
