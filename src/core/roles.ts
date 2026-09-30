/**
 * Built-in roles for spawn_agent and pipeline steps.
 * Simplified from the previous file-based resolution system.
 * 4 roles covering distinct cost/capability combinations.
 */

import type { ModelTier, EffortLevel, AutonomyLevel } from '../types/index.js';
// Wire contract (CP emits `LYNOX_ACCOUNT_TIER`) — SoT in src/contract/vocab.ts.
import type { AccountTier } from '../contract/vocab.js';
import type { ToolResolutionProfile } from '../tools/resolve-tools.js';

export interface RoleConfig {
  readonly model: ModelTier;
  readonly effort: EffortLevel;
  readonly autonomy: AutonomyLevel;
  readonly denyTools?: readonly string[] | undefined;
  readonly allowTools?: readonly string[] | undefined;
  /**
   * The role's tool grant is {@link READ_ONLY_TOOL_SURFACE}, not a subtraction from
   * the parent set. A role that tells the model it is read-only must say so with
   * THIS field: a role stating it in `description` alone is rejected by
   * `roles.test.ts` ("every role that says read-only carries the flag").
   */
  readonly readOnly?: boolean | undefined;
  readonly description: string;
}

/**
 * The tools a `readOnly` role may hold — an ALLOWLIST, so a tool that does not
 * appear here is not granted, including one added after this list was written.
 *
 * Membership criterion, applied per tool by reading its handler AND the store
 * methods that handler calls: a write is harmless exactly when its only effect is
 * to log THIS run or make it resumable. Anything that changes what a LATER run
 * sees, does or shows is a write. The per-tool test question is "does a later run
 * behave differently because this call happened?" — which is why `ask_secret` is
 * absent: its prompt row is settled by the answer, and the value it collects lands
 * in the vault, where every later run resolves it.
 *
 * The line this is easiest to get wrong on, so it is drawn here rather than left to
 * the reader: a read that fills a PROCESS cache with what it just read is not a
 * write for this purpose — a call that changes what a later render SELECTS is one.
 * `memory_focus` is why the distinction is written down. It persists nothing, and
 * it is absent from this list all the same, because the field it sets lives on the
 * engine's single KnowledgeStore and the always-loaded block render falls back to
 * it on every later turn, in every thread. "Touches no row" answers a narrower
 * question than the criterion asks.
 *
 * SPEND is out of scope, deliberately. A member that makes its own metered call —
 * the rerank inside `web_research` — costs money, and money is governed by the
 * budget cap and the overdraft gate, which bind every role alike. Read this list as
 * a statement about STATE; read as a statement about cost it would be empty, since
 * a turn that calls any member spends tokens.
 *
 * Names that are not registered in a given configuration are inert: this is an
 * allowlist, so a conditionally-registered tool (`recall`, `archive_search` and
 * `memory_recall` behind the durable-memory flags, `data_store_*` behind a live
 * DataStore handle, `calendar_read` behind a connected feed, `web_research` behind
 * a reachable search provider) is listed once and simply does not match when its
 * condition is absent — the same no-op the `collector` grant below relies on.
 *
 * `read-only-role-surface-boot.test.ts` bounds the list against a booted Engine,
 * and checks a `readOnly` role's grant against TWO independent references: this
 * list, and the `destructive` / `requiresConfirmation` flags each tool's own author
 * sets. The second exists because the first is written here — a reference that an
 * edit to this file can satisfy is no reference at all.
 */
export const READ_ONLY_TOOL_SURFACE: readonly string[] = Object.freeze([
  // Filesystem + context
  'read_file',
  'recall_tool_result',
  // Durable knowledge (DK.1) — the retrieval side only.
  'recall',
  'archive_search',
  // Legacy namespace memory — load/list only.
  'memory_recall',
  'memory_list',
  // Records, read side. `contacts_search` reaches `crm.ensureSchema()`, which is a
  // latch already closed during boot; the CRM's DDL is therefore unreachable here.
  'contacts_search',
  'data_store_query',
  'data_store_list',
  'artifact_list',
  'artifact_history',
  'task_list',
  // Workflows, read side: both only project stored runs into text.
  'diagnose_workflow_run',
  'export_workflow',
  // Outbound retrievals, neither of which writes anything locally — the ICS feed is
  // fetched per call and never cached to disk.
  //
  // The line against `http_request`, which is deliberately absent, is not the verb:
  // the DuckDuckGo fallback posts a form to the HTML SERP
  // (`search-provider.ts` — the SearXNG path GETs). It is what the MODEL supplies. On
  // these two it supplies a query, a feed name, or a URL to read; the request itself
  // is built by the provider and carries no caller body — the extract path is a
  // bodyless GET restricted to text/html (`content-extractor.ts`). On `http_request`
  // the model supplies the method and the body as well, which is a different thing to
  // hold.
  'web_research',
  'calendar_read',
  // End-of-turn UI action: the handler's only effect is the tool_result that closes
  // the pair (`suggest-follow-ups.ts`).
  //
  // `ask_user` is NOT here, and it is the candidate that looks most like it belongs.
  // On the worker-loop path the question is a durable `pending_prompts` INSERT, the
  // trigger is parked with `status: 'waiting'`, a push notification goes to the
  // user's devices, and the answer starts a FRESH run seeded with it
  // (`worker-loop.ts`). Its prompt row being settled by the answer is true and does
  // not settle the trigger row or the notification. A read-only role reports to its
  // parent, and the parent can ask.
  'suggest_follow_ups',
]);

/** The shape `resolveTools` takes — defined there, re-exported here by name. */
export type RoleToolProfile = ToolResolutionProfile;

/**
 * The ONE place a role becomes a tool-resolution profile.
 *
 * Both grant paths — `spawn_agent` (`tools/builtin/spawn.ts`) and inline pipeline
 * steps (`orchestrator/runtime-adapter.ts`) — call this, so `readOnly` cannot
 * reach one path and be missed by the other. Each used to build the object
 * inline from `allowTools`/`denyTools`, which is two places to keep in step.
 */
export function roleToolProfile(role: RoleConfig): RoleToolProfile {
  const allowed = role.readOnly
    ? [...READ_ONLY_TOOL_SURFACE]
    : role.allowTools ? [...role.allowTools] : undefined;
  return {
    allowedTools: allowed,
    deniedTools: role.denyTools ? [...role.denyTools] : undefined,
    // Carried through so `resolveTools` treats `allowedTools` as a CEILING rather
    // than a tier an explicit tool list can step around.
    readOnly: role.readOnly,
  };
}

export const BUILTIN_ROLES: Record<string, RoleConfig> = {
  researcher: {
    // Default is the `balanced` tier for all accounts — bench (2026-04) showed
    // the balanced tier + adaptive-thinking matches the `deep` tier on
    // deep-research tasks at a fraction of the cost. Any account can still
    // override via explicit `model: 'deep'` on the spawn call — the capability
    // gate was retired (D8); the included budget + the `max_tier` clamp control
    // cost, not a per-account tier lock.
    model: 'balanced',
    effort: 'max',
    autonomy: 'guided',
    readOnly: true,
    // Kept alongside `readOnly`, not replaced by it: `denyTools` applies AFTER the
    // allowlist, so it is a second, independent subtraction that would still remove
    // these two if they were ever added to the surface by mistake.
    denyTools: ['write_file', 'bash'],
    description: 'Thorough exploration, source citation. Read-only.',
  },
  creator: {
    model: 'balanced',
    effort: 'high',
    autonomy: 'guided',
    denyTools: ['bash'],
    description: 'Content creation, tone adaptation. No system commands.',
  },
  operator: {
    model: 'fast',
    effort: 'high',
    autonomy: 'autonomous',
    // The only role with `autonomy: 'autonomous'`, so its grant is the one that most
    // needs to be a ceiling rather than a default: no turn of its run is reviewed
    // before the next one starts.
    readOnly: true,
    denyTools: ['write_file'],
    description: 'Fast status checks, concise reporting. Read-only.',
  },
  collector: {
    model: 'fast',
    effort: 'medium',
    autonomy: 'supervised',
    // Superset: the legacy memory_store/recall AND the DK.1 remember/recall — allowTools is a
    // whitelist, so listing the not-registered pair for the current flag state is a harmless
    // no-op, and the collector role works under both flag states (H9 — no partial swap).
    //
    // read_file + http_request + web_research are here because the engine ACTIVELY
    // recommends role='collector' to work a payload too large for the main context in
    // isolation: read_file for large files (the fs.ts soft/hard-cap hints name collector
    // to "summarize the full file" the parent could only partly read), http_request for
    // large API responses (http.ts truncation hints), web_research for large web fetches.
    // allowTools is hard-enforced as a whitelist (resolve-tools.ts), so omitting the tool
    // a hint recommends left the collector unable to do the one job it was spawned for
    // — the model would spawn a collector, the collector would lack the tool,
    // and the fetch/read silently never happened. It holds no write_file, no edit_file
    // and no bash — but see below: that is narrower than read-only.
    allowTools: ['ask_user', 'memory_store', 'memory_recall', 'remember', 'recall', 'archive_search', 'read_file', 'http_request', 'web_research'],
    // NOT `readOnly`, and the description no longer says it is: three of the tools
    // above are writes under the criterion in READ_ONLY_TOOL_SURFACE. `memory_store`
    // and `remember` persist for later runs by design — that is the role's job — and
    // `http_request` carries the write verbs. They are named exceptions, so the grant
    // stays the explicit `allowTools` list rather than the shared surface.
    description: 'Work large payloads (files, API responses, web) in an isolated context; structured Q&A with user. Writes only to memory; makes outbound HTTP calls.',
  },
};

/** Get a role config by name. Returns undefined if not found. */
export function getRole(name: string): RoleConfig | undefined {
  return BUILTIN_ROLES[name];
}

/** List all available role names. */
export function getRoleNames(): string[] {
  return Object.keys(BUILTIN_ROLES);
}

export type { AccountTier };

/**
 * Resolve an explicit model override. Historically this GATED the `deep` tier
 * behind a Managed-Pro entitlement — a managed-standard caller asking for
 * `model: 'deep'` was silently downgraded to `balanced`.
 *
 * That capability gate is RETIRED (D8, 2026-06-17). With the flexible Tier-Set,
 * gating the tier BAND is incoherent: `deep` no longer means "Opus" (a tenant
 * can map it to a cheap Mistral-Large), so a band gate would wrongly block a
 * cheap deep tier while a band-allowed model could be the expensive one. Cost is
 * controlled where it actually lives — the included BUDGET (overdraft cap →
 * block/suspend, `usage.ts`) + per-model cost transparency in the settings UI —
 * not by an arbitrary tier lock. So this is now a PASS-THROUGH: any account may
 * request any tier.
 *
 * Kept as the single seam every model-resolution path delegates through (rather
 * than inlined/deleted) so any future policy stays a one-line change here; the
 * `_accountTier` param is retained for caller stability + that forward-compat.
 */
export function applyTierGate(
  requestedModel: ModelTier | undefined,
  _accountTier: AccountTier | undefined,
): ModelTier | undefined {
  return requestedModel;
}
