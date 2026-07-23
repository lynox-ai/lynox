/**
 * lynox model-fitness harness — shared types.
 *
 * The core asset is the CAPABILITY MAP: the specific points where an LLM's
 * strength decides lynox-fit-or-not (tool selection, correct first call,
 * terminal-tool compliance, tool-call reliability, JSON/schema fidelity,
 * vision, …). Each point is a triggering case + an asserted-correct behaviour,
 * run across candidate models to produce a per-model FITNESS matrix that says
 * "which model does which job (tier)". NOT a generic benchmark rank — the value
 * is testing on lynox's OWN tools + prompt discipline (DEF-model-compat-harness).
 *
 * v1 is deliberately CHEAP: a small suite of short cases on the tier-routed
 * candidates × ≥2 providers, few repeats. Public leaderboards (BFCL v4 /
 * τ-bench) are the FREE pre-filter that decides which models are candidates at
 * all — see models.ts `prefilter`. The full agentic (τ-bench-style multi-step)
 * bench comes later.
 */
import type { Agent } from '../../src/core/agent.js';
import type { ToolEntry } from '../../src/types/index.js';

export type Tier = 'fast' | 'balanced' | 'deep';

/** A candidate model to score, with the PROVENANCE for why it's a candidate
 *  (the free pre-filter). `provider: 'openai'` = an OpenAI-compatible endpoint
 *  (Mistral). Always a dated snapshot — never a `-latest` tag (rate limits). */
export interface Candidate {
  readonly id: string;
  readonly label: string;
  readonly provider: 'anthropic' | 'openai';
  readonly apiBaseURL?: string;
  /** Env var holding this candidate's API key. Defaults by provider (anthropic →
   *  ANTHROPIC_API_KEY, openai → MISTRAL_API_KEY). Set for an OpenAI-compatible
   *  host that is NOT Mistral — e.g. a Fireworks-hosted model → FIREWORKS_API_KEY. */
  readonly keyEnv?: string;
  /** The lynox tier(s) this model is a candidate FOR. */
  readonly tierHint: Tier | null;
  /** Why it's a candidate — a public-leaderboard note or a known fact. */
  readonly prefilter: string;
}

/** How a capability case builds a model-configured Agent. The harness injects
 *  the candidate's provider/key/base-url; the case supplies name/prompt/tools. */
export type MakeAgent = (opts: {
  name: string;
  systemPrompt?: string;
  tools: ToolEntry[];
  maxIterations?: number;
  /** Override the ask_user hook — a multi-step scenario passes a SIMULATED user
   *  (an LLM answering the agent's clarifications from a persona/goal). */
  promptUser?: (question: string, options?: string[]) => Promise<string>;
}) => Agent;

/** Outcome of ONE run of one capability case. */
export interface CaseResult {
  readonly pass: boolean;
  /** Short evidence for the matrix cell / debugging. */
  readonly note?: string;
}

/** A lynox capability-critical point + its case. */
export interface Capability {
  readonly id: string;
  /** The capability-critical point, one line. */
  readonly point: string;
  /** Which tier(s) this point gates — a fast-tier model that fails a
   *  fast-critical point is unfit for that tier. */
  readonly tiers: readonly Tier[];
  /** The specific lynox JOB this point stands in for (e.g. 'kg-entity-extraction',
   *  'inbox-classify', 'main-chat-multistep'), from the tier→jobs spine in the
   *  design doc. Absent for cross-cutting capabilities (tool-call reliability,
   *  schema fidelity, injection-resistance) that every job depends on. Lets the
   *  map be read as "which jobs of tier X are covered". */
  readonly job?: string;
  /** How it's asserted (deterministic where possible). */
  readonly detail: string;
  /** A PER-JOB context floor (rafael 2026-07-19): a specialized job (e.g.
   *  big-context ingestion/analysis) needs a bigger window than the tier's
   *  general floor. A candidate below this is context-SKIPPED for this case (not
   *  run — saves API). This is why >1M is NOT a blanket deep-tier requirement:
   *  it lives on the specific JOB that needs it, not the whole tier. */
  readonly minContext?: number;
  /** Run the case once against a candidate (via the injected Agent factory). */
  readonly run: (make: MakeAgent) => Promise<CaseResult>;
}

/** One matrix cell: a capability × a candidate, aggregated over repeats. */
export interface MatrixCell {
  readonly capabilityId: string;
  readonly candidateId: string;
  readonly passes: number;
  readonly runs: number;
  readonly errors: number;
  readonly lastNote?: string;
}
