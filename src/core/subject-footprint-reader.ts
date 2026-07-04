import type { DataStore } from './data-store.js';
import type { SubjectStore } from './subject-store.js';
import type { MemoryGraphStore } from './memory-graph-store.js';
import type { ThreadStore, ThreadRecord } from './thread-store.js';
import type { TaskStore } from './task-store.js';
import type { TaskRecord } from '../types/index.js';

/**
 * Record-on-Spine R2b — the re-leveled subject-FOOTPRINT read. NOT a new primitive
 * or agent tool: an id-keyed, on-demand PROJECTION of the already-shaped subject
 * graph (R1 subjects/aliases/hierarchy + R2a record columns/`occurred_at`), assembled
 * across the stores that each own one soft-ref to a subject.
 *
 * The honest cut (per the /primitive-lens verdict): only records + threads inhabit an
 * occurrence TIMELINE (records carry a true `occurred_at` event time; a thread's
 * activity time is a fair proxy). memories (`created_at` = when LEARNED) and tasks
 * (`due_date` = FUTURE) are ADJACENT reference sections — merging them into the time
 * sort would misorder (a memo written today about a year-old invoice would float to
 * "now"). relationships / engagements / connections are excluded entirely — they are
 * structural edges/intervals/capabilities, not occurrences.
 *
 * Composed OUTSIDE the per-turn `retrieve()` hot path — this is a deliberate on-demand
 * read (a UI open / a future gated recall), never folded into every chat turn.
 */

/** A memory in a subject's footprint — lean projection (drops the embedding blob +
 *  internal lifecycle counters that a footprint never displays). */
export interface SubjectFootprintMemory {
  id: string;
  text: string;
  createdAt: string;
  confidence: number;
}

/** One entry on the occurrence timeline — a record row OR an anchored thread. A
 *  discriminated union so the render can style each without re-deriving the source.
 *  `occurredAt` is the sort key (records: event/insert time; threads: activity time);
 *  `occurredAtIsEventTime` (records only) flags a true `occurred_at` vs an insert-time
 *  fallback, so a billing-grade view can show the provenance honestly. */
export type SubjectTimelineEntry =
  | {
      type: 'record';
      occurredAt: string | null;
      occurredAtIsEventTime: boolean;
      collection: string;
      matchedColumns: string[];
      row: Record<string, unknown>;
    }
  | {
      type: 'thread';
      occurredAt: string;
      thread: ThreadRecord;
    };

/** Whether a section hit its row cap (more exist) — a conservative "there may be
 *  more" hint per store, never a silent truncation. */
export interface SubjectFootprintTruncation {
  records: boolean;
  threads: boolean;
  memories: boolean;
  tasks: boolean;
}

/** The assembled footprint of ONE subject. */
export interface SubjectFootprint {
  subject: { id: string; kind: string; name: string };
  /** records + threads, each item at its most-meaningful time, newest-first. */
  timeline: SubjectTimelineEntry[];
  /** Adjacent — semantic facts about the subject (created_at ordered). */
  memories: SubjectFootprintMemory[];
  /** Adjacent — tasks assigned to the subject (future due_date). */
  tasks: TaskRecord[];
  truncated: SubjectFootprintTruncation;
}

const DEFAULT_LIMIT = 50;
// Capped at the SMALLEST per-store internal cap (`memoriesMentioningSubject` clamps
// its own limit to 100; records/tasks/threads clamp to 500). Asking a store for more
// than it will ever return would make the `length >= limit` truncation signal lie
// (100 rows back on a limit of 150 reads as "not truncated" while cutting silently).
const MAX_LIMIT = 100;

/**
 * Composes a subject's footprint from the stores that each hold a soft-ref to it.
 * Each store lives behind its own handle (records = datastore.db; memories/tasks =
 * engine.db; threads = the live history.db handle) — the reader is the thin seam that
 * fans out N indexed point-lookups and merges the two timeline sources. Stateless;
 * safe to construct per-engine-init (mirrors SubjectStore).
 */
export class SubjectFootprintReader {
  constructor(
    private readonly subjects: SubjectStore,
    private readonly dataStore: DataStore,
    private readonly memoryGraph: MemoryGraphStore,
    private readonly threads: ThreadStore,
    private readonly tasks: TaskStore,
  ) {}

  /**
   * The id-keyed footprint. Returns null when the subject is stale/purged/merged-away
   * (a cross-DB soft ref with no enforceable FK — a dangling id must degrade to "no
   * footprint", not crash). `limit` bounds EACH section independently.
   *
   * Records are occurrence-ordered (R2a index + `occurred_at`) and interleaved with
   * anchored threads (activity time) into one newest-first timeline; memories and
   * tasks are returned as adjacent sections. Genuine store/DB errors propagate — this
   * is an on-demand read, so the caller (a UI route) surfaces them rather than
   * silently returning a partial footprint.
   */
  getFootprint(subjectId: string, opts?: { limit?: number | undefined }): SubjectFootprint | null {
    const subject = this.subjects.getSubject(subjectId);
    if (!subject) return null;

    const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

    const rec = this.dataStore.getRecordsForSubject(subjectId, { limit });
    const threadRows = this.threads.listBySubjectId(subjectId, limit);
    // Direct mentions only — the honest "about THIS subject". `relatedMemoriesViaSubjects`
    // surfaces a NEIGHBOUR's memories (a relationship hop), which is not this subject's
    // footprint; kept out deliberately.
    const memoryRows = this.memoryGraph.memoriesMentioningSubject(subjectId, true, limit);
    const taskRows = this.tasks.listBySubjectId(subjectId, limit);

    const timeline: SubjectTimelineEntry[] = [
      ...rec.occurrences.map((o): SubjectTimelineEntry => ({
        type: 'record',
        occurredAt: o.occurredAt,
        occurredAtIsEventTime: o.occurredAtIsEventTime,
        collection: o.collection,
        matchedColumns: o.matchedColumns,
        row: o.row,
      })),
      ...threadRows.map((t): SubjectTimelineEntry => ({
        type: 'thread',
        occurredAt: t.updated_at,
        thread: t,
      })),
    ].sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''));

    const memories: SubjectFootprintMemory[] = memoryRows.map(m => ({
      id: m.id,
      text: m.text,
      createdAt: m.created_at,
      confidence: m.confidence,
    }));

    return {
      subject: { id: subject.id, kind: subject.kind, name: subject.name },
      timeline,
      memories,
      tasks: taskRows,
      truncated: {
        records: rec.truncated,
        threads: threadRows.length >= limit,
        memories: memoryRows.length >= limit,
        tasks: taskRows.length >= limit,
      },
    };
  }
}
