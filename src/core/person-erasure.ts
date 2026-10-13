/**
 * Erasing one person from what the agent remembers — the targeted answer to a data-subject
 * request, where `DELETE /api/data` can only erase the whole instance.
 *
 * Two calls. {@link previewPersonErasure} lists what would go, with the text, so the owner
 * decides on what they read. {@link erasePerson} erases exactly that, and refuses when the set
 * has changed since.
 *
 * What it finds, in two groups:
 *  - bound to the person: durable entries and memories engine.db attaches to the subject or to
 *    a shell merged into it. These always go with the person.
 *  - name matches: an unresolved `subject_hint`; the name, an alias or the email in a text; a
 *    legacy person entity under the name or an alias, with the memories that mention it. Shown,
 *    never selected on their own: "Anna" can be another Anna. Each goes only when the owner
 *    names it.
 * The person is found by their subject: someone only the legacy store knows is not reached.
 *
 * The order is what makes a retry finish what a failure left: durable entries, then the legacy
 * memories and selected legacy entities, then the engine.db stubs (the store the ids are derived
 * from goes last), then the subject itself, whose id is what a retry starts from. A failed step
 * stops the run; the steps after it do not run. Every step is idempotent. Deleting the stubs also
 * reaps a subject they were the last holder of (`MemoryGraphStore.purgeMemories`), an empty
 * record that nothing else refers to. The steps run with `secure_delete` on, and afterwards the
 * write-ahead logs are folded in and truncated (`scrubbed` says whether that finished), so the
 * deleted text does not stay behind in free pages or the log.
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
/** A legacy person entity under the person's name: selecting it erases it and the memories that mention it. */
export interface PersonErasureLegacyEntity { id: string; name: string; description: string; memoryIds: string[] }

export interface PersonErasurePreview {
  subject: { id: string; name: string; aliases: string[] };
  entries: PersonErasureEntry[];
  memories: PersonErasureMemory[];
  legacyEntities: PersonErasureLegacyEntity[];
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
  /** The canonical subject the erasure ran on (a merged-away id resolves to it). */
  subjectId: string;
  /**
   * What went: durable entries; memories (each erased in both stores, counted once when both
   * memory steps finished); legacy entities; the person's subjects that are gone afterwards.
   */
  counts: { entries: number; memories: number; legacyEntities: number; subjects: number };
  /** Whether the write-ahead logs were folded in and truncated. */
  scrubbed: boolean;
  /** Name matches the owner did not select: they stay. */
  left: { entries: number; memories: number; legacyEntities: number; blocks: MemoryBlockId[] };
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
type Collected = { preview: PersonErasurePreview; unlinkedStubs: ReadonlySet<string> };

function resolve(deps: PersonErasureDeps, subjectId: string): Resolved | PersonErasureRefusal {
  const canonical = deps.subjects.resolveActiveSubject(subjectId);
  const row = deps.subjects.getSubject(canonical);
  if (!row) return { refused: 'not_found' };
  if (row.is_self === 1) return { refused: 'is_self' };
  if (row.kind !== 'person') return { refused: 'not_a_person' };
  const shells = deps.subjects.mergedShellIds(canonical);
  // A merge folds the shell's name and aliases into the canonical row, but rolling back an
  // older merge into the same canonical can take a form out again that a remaining shell still
  // carries (`SubjectStore.rollbackMerge`), so the shells are read too.
  const aliases = new Set(parseAliases(row.aliases));
  for (const id of shells) {
    const shell = deps.subjects.getSubject(id);
    if (shell) { aliases.add(shell.name); for (const a of parseAliases(shell.aliases)) aliases.add(a); }
  }
  aliases.delete(row.name);
  const email = deps.subjects.personEmailForErasure(canonical);
  const forms = [row.name, ...aliases, ...(email ? [email] : [])];
  return { canonical, shells, name: row.name, aliases: [...aliases], forms };
}

function planOf(deps: PersonErasureDeps, r: Resolved, p: Omit<PersonErasurePreview, 'plan' | 'subject' | 'notCovered' | 'blocksMentioning'>): string {
  return deps.engineDb.keyedHash([
    'person-erasure:v2',
    r.canonical,
    ...[...r.shells].sort().map(id => `s:${id}`),
    ...p.entries.map(e => `e:${e.id}:${e.matchedBy}`).sort(),
    ...p.memories.map(m => `m:${m.id}:${m.matchedBy}`).sort(),
    ...p.legacyEntities.map(n => `n:${n.id}:${[...n.memoryIds].sort().join(',')}`).sort(),
  ]);
}

function collect(deps: PersonErasureDeps, subjectId: string): Collected | PersonErasureRefusal {
  const r = resolve(deps, subjectId);
  if ('refused' in r) return r;
  const ids = new Set([r.canonical, ...r.shells]);
  const matches = personMatcher(r.forms);
  const entries = deps.knowledge.erasureCandidates(ids, matches);
  // Entity names are matched whole, so the same length floor as the text search applies.
  const names = [r.name, ...r.aliases].filter(n => n.normalize('NFKC').trim().length >= MIN_FORM_LENGTH);
  const found = deps.layer.erasureMemoryCandidates(ids, names, matches);
  const memories = found.memories.map(m => ({ ...m, text: deps.mask(m.text) }));
  const legacyEntities = found.entities.map(n => ({ ...n, name: deps.mask(n.name), description: deps.mask(n.description) }));
  return {
    preview: {
      subject: { id: r.canonical, name: r.name, aliases: r.aliases },
      entries,
      memories,
      legacyEntities,
      blocksMentioning: deps.knowledge.blocksMentioning(matches),
      plan: planOf(deps, r, { entries, memories, legacyEntities }),
      notCovered: PERSON_ERASURE_NOT_COVERED,
    },
    unlinkedStubs: new Set(found.unlinkedStubs),
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
    subjectId: string; plan: string;
    entryIds: readonly string[]; memoryIds: readonly string[]; entityIds?: readonly string[] | undefined;
    /** Runs after every check and before the first step; a throw refuses with nothing erased. */
    beforeErase?: (planned: { subjectId: string; entries: number; memories: number; legacyEntities: number }) => void;
  },
): PersonErasureResult | PersonErasureRefusal {
  const collected = collect(deps, input.subjectId);
  if ('refused' in collected) return collected;
  const { preview } = collected;
  if (preview.plan !== input.plan) return { refused: 'plan_changed' };

  const pickedEntityIds = input.entityIds ?? [];
  const entryCandidates = new Set(preview.entries.map(e => e.id));
  const memoryCandidates = new Set(preview.memories.map(m => m.id));
  const entityCandidates = new Map(preview.legacyEntities.map(n => [n.id, n]));
  const unknown = [
    ...input.entryIds.filter(id => !entryCandidates.has(id)),
    ...input.memoryIds.filter(id => !memoryCandidates.has(id)),
    ...pickedEntityIds.filter(id => !entityCandidates.has(id)),
  ];
  if (unknown.length > 0) return { refused: 'unknown_ids', ids: unknown };

  const pickedEntries = new Set(input.entryIds);
  const entryIds = preview.entries.filter(e => e.matchedBy === 'subject' || pickedEntries.has(e.id)).map(e => e.id);
  const entityIds = [...new Set(pickedEntityIds)];
  const viaEntities = new Set(entityIds.flatMap(id => entityCandidates.get(id)!.memoryIds));
  const memorySet = new Set([
    ...preview.memories.filter(m => m.matchedBy === 'subject').map(m => m.id),
    ...input.memoryIds,
    ...viaEntities,
  ]);
  const memoryIds = [...memorySet];
  const canonical = preview.subject.id;
  const personSubjects = [canonical, ...deps.subjects.mergedShellIds(canonical)];
  try {
    input.beforeErase?.({ subjectId: canonical, entries: entryIds.length, memories: memoryIds.length, legacyEntities: entityIds.length });
  } catch {
    return { refused: 'audit_unavailable' };
  }

  const result: PersonErasureResult = {
    erased: false,
    done: [],
    failed: null,
    error: null,
    subjectId: canonical,
    counts: { entries: 0, memories: 0, legacyEntities: 0, subjects: 0 },
    scrubbed: false,
    left: {
      entries: preview.entries.length - entryIds.length,
      memories: preview.memories.filter(m => !memorySet.has(m.id)).length,
      legacyEntities: preview.legacyEntities.length - entityIds.length,
      blocks: preview.blocksMentioning,
    },
    notCovered: PERSON_ERASURE_NOT_COVERED,
  };

  const steps: Array<[PersonErasureStep, () => void]> = [
    ['durable_knowledge', () => {
      // `entryIds` holds every bound entry (canonical and shells) and the selected matches.
      let n = 0;
      for (const id of entryIds) if (deps.knowledge.deleteEntry(id)) n++;
      result.counts.entries = n;
    }],
    // A memory reached only through a selected legacy entity loses that link with its legacy
    // row, and nothing in engine.db attaches it to the person, so its stub goes first.
    ['memories_legacy', () => {
      const first = [...viaEntities].filter(id => collected.unlinkedStubs.has(id));
      if (first.length > 0) deps.layer.purgeMemoryStubsForErasure(first);
      deps.layer.purgeLegacyMemoriesForErasure(memoryIds, entityIds);
      result.counts.legacyEntities = entityIds.length;
    }],
    ['memories_engine', () => {
      deps.layer.purgeMemoryStubsForErasure(memoryIds);
      result.counts.memories = memoryIds.length;
    }],
    // Counted as the person's subjects that are gone afterwards: the engine.db step's orphan
    // reap can already have taken one that nothing else held.
    ['subject', () => {
      deps.subjects.eraseSubject(canonical);
      result.counts.subjects = personSubjects.filter(id => deps.subjects.getSubject(id) === null).length;
    }],
  ];

  // While the steps run, SQLite overwrites what they delete instead of leaving it in free pages.
  const legacyDb = deps.layer.getDb();
  let engineBefore: boolean | null = null;
  let legacyBefore: boolean | null = null;
  try {
    engineBefore = deps.engineDb.setSecureDelete(true);
    legacyBefore = legacyDb.setSecureDelete(true);
    for (const [step, run] of steps) {
      run();
      result.done.push(step);
    }
    result.erased = true;
  } catch (err: unknown) {
    result.failed = PERSON_ERASURE_STEPS[result.done.length] ?? 'durable_knowledge';
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { if (engineBefore !== null) deps.engineDb.setSecureDelete(engineBefore); } catch { /* best effort */ }
    try { if (legacyBefore !== null) legacyDb.setSecureDelete(legacyBefore); } catch { /* best effort */ }
  }
  // The write-ahead log still holds the pages as they were before the delete; folding it into
  // the file and truncating it takes those copies out. Also after a failed step: what that run
  // did delete is gone from the log too. A reader can keep it from finishing, which undoes
  // nothing and is said in the answer.
  let engineScrubbed = false;
  let legacyScrubbed = false;
  try { engineScrubbed = deps.engineDb.checkpointTruncate(); } catch { /* reported as not scrubbed */ }
  try { legacyScrubbed = legacyDb.checkpointTruncate(); } catch { /* reported as not scrubbed */ }
  result.scrubbed = engineScrubbed && legacyScrubbed;
  return result;
}

/** The steps in the order {@link erasePerson} runs them. */
export const PERSON_ERASURE_STEPS: readonly PersonErasureStep[] = ['durable_knowledge', 'memories_legacy', 'memories_engine', 'subject'];
