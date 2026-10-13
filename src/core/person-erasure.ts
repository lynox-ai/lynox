/**
 * Erasing one person from what the agent remembers — the targeted answer to a data-subject
 * request, where `DELETE /api/data` can only erase the whole instance.
 *
 * Two calls. {@link previewPersonErasure} lists what would go, with the text, so the owner
 * decides on what they read. {@link erasePerson} erases exactly that, and refuses when the set
 * has changed since: what the owner confirmed is what the run gets.
 *
 * What it finds, in two groups:
 *  - bound to the person: durable entries and memories attached to the subject or to a shell
 *    merged into it, and legacy memories linked to a legacy person entity under the person's
 *    name or an alias (that store's own link, there whether or not the subject graph is on).
 *    These always go with the person, and so do those legacy entities.
 *    The person is found by their subject: someone the legacy store alone knows is not reached.
 *  - name matches: an unresolved `subject_hint`, or the name, an alias or the email in the
 *    text. Shown, never selected on their own: "Anna" can be another Anna. Each goes only when
 *    the owner names it.
 *
 * The order is what makes a retry finish what a failure left: durable entries, then the legacy
 * memories, then their engine.db stubs (the store the ids are derived from goes last), then the
 * subject itself, whose id is what a retry starts from. A failed step stops the run; the steps
 * after it do not run. Every step is idempotent. The steps run with `secure_delete` on, and after
 * the last one the write-ahead logs are folded in and truncated (`scrubbed` says whether that
 * finished), so the deleted text does not stay behind in free pages or the log.
 *
 * What it does not reach is part of every answer ({@link PERSON_ERASURE_NOT_COVERED}).
 */
import type { EngineDb } from './engine-db.js';
import type { SubjectStore } from './subject-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeLayer } from './knowledge-layer.js';
import type { KnowledgeStatus, MemoryBlockId } from '../types/memory.js';

/** The confirmation word the erase call must carry. */
export const PERSON_ERASURE_CONFIRM = 'ERASE_PERSON';

/**
 * What a person erasure does not reach. Every answer lists these keys, and the web UI names
 * them; `person-erasure.test.ts` holds this list against the data-dir inventory.
 */
export const PERSON_ERASURE_NOT_COVERED = [
  'backups',
  'exports',
  'chat_and_run_history',
  'agent_questions',
  'mail',
  'crm_records',
  'flat_file_memory',
  'tasks_and_automations',
  'change_ledger',
  'other_relationships',
  'files',
  'debug_capture',
  'measurement_logs',
  'audit_log',
] as const;
export type PersonErasureNotCovered = typeof PERSON_ERASURE_NOT_COVERED[number];

/**
 * Every data-dir entry the full erasure handles, and what the person erasure does with it:
 * `covered` (the person's rows go), a {@link PersonErasureNotCovered} key (left as it is), or
 * `{ none }` with why it holds nothing about a third person. A new entry in
 * `DATA_DIR_INVENTORY` fails the test until it is decided here.
 */
export const PERSON_ERASURE_REACH: Readonly<Record<string, ReadonlyArray<'covered' | PersonErasureNotCovered> | { none: string }>> = {
  'engine.db': ['covered', 'tasks_and_automations', 'agent_questions', 'change_ledger', 'other_relationships', 'audit_log'],
  'agent-memory.db': ['covered'],
  'history.db': ['chat_and_run_history'],
  'datastore.db': ['crm_records'],
  'mail-state.db': ['mail'],
  'memory': ['flat_file_memory'],
  'artifacts': ['files'],
  'apis': ['files'],
  'workspace': ['files'],
  'sweeps': ['files'],
  'backups': ['backups'],
  'wire-sink': ['debug_capture'],
  'wire-sink-raw': ['debug_capture'],
  'batch-index.json': ['debug_capture'],
  'capture-telemetry.jsonl': ['measurement_logs'],
  'context-cost.jsonl': ['measurement_logs'],
  'memory-write.jsonl': ['measurement_logs'],
  'memory-write-decision.jsonl': ['measurement_logs'],
  'retrieval-shadow.jsonl': ['measurement_logs'],
  'untrusted-cause.jsonl': ['measurement_logs'],
  'config.json': { none: 'the instance settings' },
  'vault.db': { none: 'the instance credentials' },
  'secrets.json': { none: 'the instance credentials' },
  'push-subscriptions.db': { none: 'the devices that receive this instance\'s notifications' },
  'sessions': { none: 'sign-in sessions of this instance\'s users' },
};

export type PersonErasureStep = 'durable_knowledge' | 'memories_legacy' | 'memories_engine' | 'subject';

export interface PersonErasureDeps {
  engineDb: EngineDb;
  subjects: SubjectStore;
  knowledge: KnowledgeStore;
  layer: KnowledgeLayer;
  /** Masks secrets in a text shown to the owner. */
  mask: (text: string) => string;
}

export interface PersonErasureEntry { id: string; status: KnowledgeStatus; text: string; matchedBy: 'subject' | 'hint' | 'mention' }
export interface PersonErasureMemory { id: string; text: string; matchedBy: 'subject' | 'mention' }

export interface PersonErasurePreview {
  subject: { id: string; name: string; aliases: string[] };
  entries: PersonErasureEntry[];
  memories: PersonErasureMemory[];
  /** The always-loaded blocks that mention the person. Named, not edited. */
  blocksMentioning: MemoryBlockId[];
  /** Derived from the ids found, never from text. The erase call must send it back. */
  plan: string;
  notCovered: readonly PersonErasureNotCovered[];
}

export type PersonErasureRefusal =
  | { refused: 'not_found' }
  | { refused: 'not_a_person' }
  | { refused: 'is_self' }
  | { refused: 'plan_changed' }
  | { refused: 'unknown_ids'; ids: string[] }
  | { refused: 'audit_unavailable' };

export interface PersonErasureResult {
  erased: boolean;
  done: PersonErasureStep[];
  failed: PersonErasureStep | null;
  /** The failed step's error, unmasked; the route masks it before it leaves. */
  error: string | null;
  counts: { entries: number; legacyMemories: number; memoryStubs: number; subjects: number };
  /** Whether the write-ahead logs were folded in and truncated after the erasure. */
  scrubbed: boolean;
  /** Name matches the owner did not select: they stay. */
  left: { entries: number; memories: number; blocks: MemoryBlockId[] };
  notCovered: readonly PersonErasureNotCovered[];
}

/** Forms shorter than this are not searched in text: two letters match nearly everything. */
const MIN_FORM_LENGTH = 3;

function parseAliases(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A matcher for the person's forms as whole words, case-insensitive, after NFKC. */
export function personMatcher(forms: readonly string[]): (text: string) => boolean {
  const usable = [...new Set(forms.map(f => f.normalize('NFKC').trim()).filter(f => f.length >= MIN_FORM_LENGTH))];
  if (usable.length === 0) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return (text: string) => re.test(text.normalize('NFKC'));
}

type Resolved = { canonical: string; shells: string[]; name: string; aliases: string[]; forms: string[] };
type Collected = { preview: PersonErasurePreview; entityIds: string[]; stubsBeforeLegacy: string[] };

function resolve(deps: PersonErasureDeps, subjectId: string): Resolved | PersonErasureRefusal {
  const canonical = deps.subjects.resolveActiveSubject(subjectId);
  const row = deps.subjects.getSubject(canonical);
  if (!row) return { refused: 'not_found' };
  if (row.is_self === 1) return { refused: 'is_self' };
  if (row.kind !== 'person') return { refused: 'not_a_person' };
  const shells = deps.subjects.mergedShellIds(canonical);
  const aliases = new Set(parseAliases(row.aliases));
  for (const id of shells) {
    const shell = deps.subjects.getSubject(id);
    if (shell) { aliases.add(shell.name); for (const a of parseAliases(shell.aliases)) aliases.add(a); }
  }
  aliases.delete(row.name);
  const email = deps.subjects.getPersonDetail(canonical)?.email;
  const forms = [row.name, ...aliases, ...(email ? [email] : [])];
  return { canonical, shells, name: row.name, aliases: [...aliases], forms };
}

function planOf(deps: PersonErasureDeps, r: Resolved, entries: PersonErasureEntry[], memories: PersonErasureMemory[], entityIds: readonly string[]): string {
  return deps.engineDb.keyedHash([
    'person-erasure:v1',
    r.canonical,
    ...[...r.shells].sort().map(id => `s:${id}`),
    ...entries.map(e => `e:${e.id}:${e.matchedBy}`).sort(),
    ...memories.map(m => `m:${m.id}:${m.matchedBy}`).sort(),
    ...[...entityIds].sort().map(id => `n:${id}`),
  ]);
}

function collect(deps: PersonErasureDeps, subjectId: string): Collected | PersonErasureRefusal {
  const r = resolve(deps, subjectId);
  if ('refused' in r) return r;
  const ids = new Set([r.canonical, ...r.shells]);
  const matches = personMatcher(r.forms);
  const entries = deps.knowledge.erasureCandidates(ids, matches);
  const found = deps.layer.erasureMemoryCandidates(ids, [r.name, ...r.aliases], matches);
  const memories = found.memories.map(m => ({ ...m, text: deps.mask(m.text) }));
  return {
    preview: {
      subject: { id: r.canonical, name: r.name, aliases: r.aliases },
      entries,
      memories,
      blocksMentioning: deps.knowledge.blocksMentioning(matches),
      plan: planOf(deps, r, entries, memories, found.entityIds),
      notCovered: PERSON_ERASURE_NOT_COVERED,
    },
    entityIds: found.entityIds,
    stubsBeforeLegacy: found.stubsBeforeLegacy,
  };
}

/**
 * What erasing this person would remove. Throws `UndecryptableTextError` when a stored text
 * cannot be read: a search that cannot read the rows must not answer "nothing found".
 */
export function previewPersonErasure(deps: PersonErasureDeps, subjectId: string): PersonErasurePreview | PersonErasureRefusal {
  const c = collect(deps, subjectId);
  return 'refused' in c ? c : c.preview;
}

/**
 * Erase the person: everything bound to them, plus the name matches the owner selected by id.
 * Refuses, changing nothing, when the set differs from the one the plan was made from, or when
 * a selected id is not a candidate. Synchronous from the check to the last step, so nothing
 * can be written in between.
 */
export function erasePerson(
  deps: PersonErasureDeps,
  input: {
    subjectId: string; plan: string; entryIds: readonly string[]; memoryIds: readonly string[];
    /** Runs after every check and before the first step; a throw refuses with nothing erased. */
    beforeErase?: (counts: { entries: number; memories: number }) => void;
  },
): PersonErasureResult | PersonErasureRefusal {
  const collected = collect(deps, input.subjectId);
  if ('refused' in collected) return collected;
  const { preview } = collected;
  if (preview.plan !== input.plan) return { refused: 'plan_changed' };

  const entryCandidates = new Set(preview.entries.map(e => e.id));
  const memoryCandidates = new Set(preview.memories.map(m => m.id));
  const unknown = [
    ...input.entryIds.filter(id => !entryCandidates.has(id)),
    ...input.memoryIds.filter(id => !memoryCandidates.has(id)),
  ];
  if (unknown.length > 0) return { refused: 'unknown_ids', ids: unknown };

  const pickedEntries = new Set(input.entryIds);
  const pickedMemories = new Set(input.memoryIds);
  const entryIds = preview.entries.filter(e => e.matchedBy === 'subject' || pickedEntries.has(e.id)).map(e => e.id);
  const memoryIds = preview.memories.filter(m => m.matchedBy === 'subject' || pickedMemories.has(m.id)).map(m => m.id);
  const canonical = preview.subject.id;
  const personSubjects = [canonical, ...deps.subjects.mergedShellIds(canonical)];
  try {
    input.beforeErase?.({ entries: entryIds.length, memories: memoryIds.length });
  } catch {
    return { refused: 'audit_unavailable' };
  }

  const result: PersonErasureResult = {
    erased: false,
    done: [],
    failed: null,
    error: null,
    scrubbed: false,
    counts: { entries: 0, legacyMemories: 0, memoryStubs: 0, subjects: 0 },
    left: {
      entries: preview.entries.length - entryIds.length,
      memories: preview.memories.length - memoryIds.length,
      blocks: preview.blocksMentioning,
    },
    notCovered: PERSON_ERASURE_NOT_COVERED,
  };

  const steps: Array<[PersonErasureStep, () => void]> = [
    ['durable_knowledge', () => {
      let n = deps.knowledge.deleteBySubject(canonical);
      for (const id of entryIds) if (deps.knowledge.deleteEntry(id)) n++;
      result.counts.entries = n;
    }],
    // A memory bound only through the legacy entity link loses that link with its legacy row, so
    // its stub goes first; the person's legacy entities go with the legacy rows.
    ['memories_legacy', () => {
      const selected = new Set(memoryIds);
      const first = collected.stubsBeforeLegacy.filter(id => selected.has(id));
      if (first.length > 0) deps.layer.purgeMemoryStubsForErasure(first);
      result.counts.legacyMemories = deps.layer.purgeLegacyMemoriesForErasure(memoryIds, collected.entityIds);
    }],
    ['memories_engine', () => { result.counts.memoryStubs = deps.layer.purgeMemoryStubsForErasure(memoryIds); }],
    // Counted as the person's subjects that are gone afterwards: the engine.db step's orphan
    // reap can already have taken one that nothing else held.
    ['subject', () => {
      deps.subjects.eraseSubject(canonical);
      result.counts.subjects = personSubjects.filter(id => deps.subjects.getSubject(id) === null).length;
    }],
  ];
  // While the steps run, SQLite overwrites what they delete instead of leaving it in free pages.
  const legacyDb = deps.layer.getDb();
  const engineBefore = deps.engineDb.setSecureDelete(true);
  const legacyBefore = legacyDb.setSecureDelete(true);
  try {
    for (const [step, run] of steps) {
      try {
        run();
        result.done.push(step);
      } catch (err: unknown) {
        result.failed = step;
        result.error = err instanceof Error ? err.message : String(err);
        return result;
      }
    }
  } finally {
    deps.engineDb.setSecureDelete(engineBefore);
    legacyDb.setSecureDelete(legacyBefore);
  }
  result.erased = true;
  // The write-ahead log still holds the pages as they were before the delete; folding it into
  // the file and truncating it takes those copies out. A reader can keep it from finishing,
  // which does not undo the erasure and is said in the answer.
  try {
    result.scrubbed = deps.engineDb.checkpointTruncate() && legacyDb.checkpointTruncate();
  } catch {
    result.scrubbed = false;
  }
  return result;
}
