/**
 * History-Preservation matcher for the P3 Blueprint phase.
 *
 * Classifies every previous-run entity + every current-run entity into
 * KEEP / RENAME / NEW / PAUSE based on stable Google IDs first, then
 * fuzzy name matching for the remainder.
 *
 * Stages:
 *  1. ID-match: entity_id present in both snapshots → KEEP
 *     (or PAUSE if the current snapshot's status indicates removal/pause).
 *  2. Name-match (token-set Jaccard ≥ threshold) on the unmatched residue
 *     → RENAME — paired by best descending score, no entity used twice.
 *  3. Only-in-current residue → NEW.
 *  4. Only-in-prev residue → PAUSE.
 *
 * The matcher is generic over entity types: callers pass arrays of
 * `MatchableEntity` shapes for any type (campaign, ad_group, keyword,
 * asset_group, ...). No SQLite or LLM dependencies.
 */
import { tokenise } from './ads-token-set-ratio.js';

export type HistoryMatchKind = 'KEEP' | 'RENAME' | 'NEW' | 'PAUSE';

export interface MatchableEntity {
  /** Stable external ID (Google's resource id, or a deterministic surrogate). */
  externalId: string;
  /** Human-readable name (campaign_name, ad_group_name, keyword text, etc.). */
  name: string;
  /** Optional status from the snapshot ('ENABLED', 'PAUSED', 'REMOVED', ...). */
  status?: string | undefined;
  /** Optional payload retained verbatim and emitted onto the decision. */
  payload?: Record<string, unknown> | undefined;
}

export interface HistoryMatchDecision {
  kind: HistoryMatchKind;
  externalId: string;
  previousExternalId: string | null;
  /** Confidence in [0, 1]. ID match → 1.0. RENAME → token-set-ratio. */
  confidence: number;
  rationale: string;
  /** Forwarded from the matched current entity (KEEP/RENAME/NEW). */
  payload?: Record<string, unknown> | undefined;
}

export interface HistoryMatchOptions {
  /** Token-set Jaccard threshold for accepting a RENAME pairing. Default 0.8. */
  renameThreshold?: number | undefined;
  /** Status values that mark an entity as paused/removed in the current snapshot. */
  pausedStatuses?: readonly string[] | undefined;
}

export interface HistoryMatchSummary {
  decisions: HistoryMatchDecision[];
  counts: Record<HistoryMatchKind, number>;
}

const DEFAULT_RENAME_THRESHOLD = 0.8;
const DEFAULT_PAUSED_STATUSES = ['PAUSED', 'REMOVED', 'DISABLED'] as const;

/**
 * Classify previous-cycle vs current-cycle entities for one entity_type.
 *
 * Both inputs are full snapshots for that type — every entity in the
 * previous run and every entity in the current run. The function never
 * mutates inputs and is deterministic given the same arrays.
 */
export function matchHistory(
  previous: readonly MatchableEntity[],
  current: readonly MatchableEntity[],
  opts?: HistoryMatchOptions | undefined,
): HistoryMatchSummary {
  const renameThreshold = opts?.renameThreshold ?? DEFAULT_RENAME_THRESHOLD;
  const pausedStatuses = new Set(opts?.pausedStatuses ?? DEFAULT_PAUSED_STATUSES);

  const decisions: HistoryMatchDecision[] = [];
  const matchedPrev = new Set<string>();
  const matchedCurr = new Set<string>();

  // Stage 1: stable-ID match.
  const currById = new Map<string, MatchableEntity>();
  for (const e of current) currById.set(e.externalId, e);
  for (const prev of previous) {
    const c = currById.get(prev.externalId);
    if (!c) continue;
    matchedPrev.add(prev.externalId);
    matchedCurr.add(c.externalId);
    const isPaused = c.status !== undefined && pausedStatuses.has(c.status.toUpperCase());
    decisions.push({
      kind: isPaused ? 'PAUSE' : 'KEEP',
      externalId: c.externalId,
      previousExternalId: prev.externalId,
      confidence: 1.0,
      rationale: isPaused
        ? `Vorgänger-Entity steht im aktuellen Snapshot auf Status ${c.status} → PAUSE.`
        : 'Stable Google-ID identisch zwischen Vorgänger- und aktuellem Snapshot.',
      ...(c.payload !== undefined ? { payload: c.payload } : {}),
    });
  }

  // Stage 2: token-set-ratio rename pairing on the unmatched residue.
  // Build all candidate (prev, curr) pairs scoring ≥ threshold, sort by
  // score desc, greedily accept while neither side is already paired.
  //
  // Pre-tokenise once + length-prune. Jaccard t = |A∩B| / |A∪B| has
  // an upper bound min(|A|,|B|) / max(|A|,|B|), so any pair whose
  // size ratio exceeds 1/threshold cannot meet the threshold. Skipping
  // those pairs avoids the O(prev × curr) explosion when the residue
  // contains thousands of keywords. Tokenisation memoised so the
  // remaining pairs reuse the same Set instances instead of re-parsing
  // the same name on every comparison.
  interface RenamePair {
    prev: MatchableEntity;
    curr: MatchableEntity;
    score: number;
  }
  const tokeniseEntity = (e: MatchableEntity): Set<string> => new Set(tokenise(e.name));
  const prevTokens = new Map<string, Set<string>>();
  const currTokens = new Map<string, Set<string>>();
  const prevResidue: MatchableEntity[] = [];
  const currResidue: MatchableEntity[] = [];
  for (const p of previous) {
    if (matchedPrev.has(p.externalId)) continue;
    prevTokens.set(p.externalId, tokeniseEntity(p));
    prevResidue.push(p);
  }
  for (const c of current) {
    if (matchedCurr.has(c.externalId)) continue;
    currTokens.set(c.externalId, tokeniseEntity(c));
    currResidue.push(c);
  }
  const sizeRatioCap = renameThreshold > 0 ? 1 / renameThreshold : Infinity;
  const pairs: RenamePair[] = [];
  for (const prev of prevResidue) {
    const prevSet = prevTokens.get(prev.externalId)!;
    if (prevSet.size === 0) continue;
    for (const curr of currResidue) {
      const currSet = currTokens.get(curr.externalId)!;
      if (currSet.size === 0) continue;
      const minSize = prevSet.size < currSet.size ? prevSet.size : currSet.size;
      const maxSize = prevSet.size > currSet.size ? prevSet.size : currSet.size;
      if (maxSize / minSize > sizeRatioCap) continue; // prune impossible pairs
      let intersection = 0;
      for (const tok of prevSet) if (currSet.has(tok)) intersection++;
      const score = intersection / (prevSet.size + currSet.size - intersection);
      if (score >= renameThreshold) pairs.push({ prev, curr, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (matchedPrev.has(p.prev.externalId) || matchedCurr.has(p.curr.externalId)) continue;
    matchedPrev.add(p.prev.externalId);
    matchedCurr.add(p.curr.externalId);
    decisions.push({
      kind: 'RENAME',
      externalId: p.curr.externalId,
      previousExternalId: p.prev.externalId,
      confidence: Math.min(1, p.score),
      rationale:
        `Name-Token-Set-Ratio ${(p.score * 100).toFixed(0)}% zwischen "${p.prev.name}" und "${p.curr.name}" — ` +
        `wahrscheinlicher Rename.`,
      ...(p.curr.payload !== undefined ? { payload: p.curr.payload } : {}),
    });
  }

  // Stage 3: residue in current → NEW.
  for (const curr of current) {
    if (matchedCurr.has(curr.externalId)) continue;
    decisions.push({
      kind: 'NEW',
      externalId: curr.externalId,
      previousExternalId: null,
      confidence: 1.0,
      rationale: 'Entity existiert nur im aktuellen Snapshot — neu seit letztem Cycle.',
      ...(curr.payload !== undefined ? { payload: curr.payload } : {}),
    });
  }

  // Stage 4: residue in previous → PAUSE.
  for (const prev of previous) {
    if (matchedPrev.has(prev.externalId)) continue;
    decisions.push({
      kind: 'PAUSE',
      externalId: prev.externalId,
      previousExternalId: prev.externalId,
      confidence: 1.0,
      rationale: 'Vorgänger-Entity fehlt im aktuellen Snapshot — gilt als entfernt/paused.',
    });
  }

  const counts: Record<HistoryMatchKind, number> = {
    KEEP: 0, RENAME: 0, NEW: 0, PAUSE: 0,
  };
  for (const d of decisions) counts[d.kind]++;

  return { decisions, counts };
}
