import type { ToolEntry, IAgent } from '../../types/index.js';
import { logErrorChain } from '../../core/utils.js';
import type { SubjectStore } from '../../core/subject-store.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';
import { ifCreated, ifTrue, withInstanceWrite } from '../../core/instance-trail.js';

// Foundation Rework v2 — Context-Hierarchy Scoping, Slice A2.
//
// The ergonomic surface over the A1 substrate: anchor the CURRENT thread to a
// project (engagement) subject and file that project under its client
// (organization) subject. It is the chat-native "put this conversation in a
// context" primitive — one intent, one call — not a bespoke form.
//
// Registered ONLY when `subject_graph_enabled` is on (engine.ts). Off in prod
// today → the tool is absent from the agent surface (zero standing surface).
//
// Stores reached via `agent.toolContext` (subjects=engine.db, threads=history.db):
// no cross-DB transaction is possible, so the engine.db writes (resolve/create/
// link subjects) run first and the history.db thread anchor runs last. A partial
// failure leaves reusable subjects and an un-anchored thread; a re-run heals it.

interface SetThreadContextInput {
  project?: string | undefined;
  customer?: string | undefined;
  clear?: boolean | undefined;
}

// Engagement resolution moved to SubjectStore.findOrCreateEngagement (the single
// resolver both this tool and the extraction path route through, so they converge
// on one row per project). Composite `(normalized-name, parent)` idempotency lives
// there; two clients can each have a "Website" project and stay distinct rows.

/**
 * The answer when the customer name matches more than one entry: the stored names of the matches
 * (which can be extracted text), each in its own marked block after the sentence, never inside it.
 */
function ambiguityText(store: SubjectStore, candidateIds: readonly string[]): string {
  const names = candidateIds
    .map(id => store.getSubject(id)?.name)
    .filter((n): n is string => typeof n === 'string');
  const head = 'The customer name matches more than one entry. Use the full name to say which one.';
  // Each name in its own block after its own label: a stored name can hold a line break, and in
  // one shared block it would read as two matches.
  return names.length > 0
    ? `${head} The stored names of the matches:${names.map((n, i) => `\nMatch ${String(i + 1)}: ${wrapUntrustedData(n, 'set_thread_context')}`).join('')}`
    : `${head} (${String(candidateIds.length)} entries)`;
}

export const setThreadContextTool: ToolEntry<SetThreadContextInput> = {
  undo: 'restorable',
  definition: {
    name: 'set_thread_context',
    description:
      "Scope this conversation to a project (and optionally a client) so notes and recall stay within it. Use when the user says the thread is about a specific project or client. Creates them if new; files the project under the client. Pass clear:true to remove.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'The project this conversation is about.' },
        customer: { type: 'string', description: 'The client the project belongs to. Optional.' },
        clear: { type: 'boolean', description: "True to remove this thread's project/client scope." },
      },
      required: [],
    },
  },
  handler: async (input: SetThreadContextInput, agent: IAgent): Promise<string> => {
    const subjects = agent.toolContext.subjectStore;
    const threads = agent.toolContext.threadStore;
    if (!subjects || !threads) {
      return 'Error: thread context is not available in this configuration (subject graph disabled).';
    }
    const threadId = agent.currentThreadId;
    if (!threadId) return 'Error: no current thread to set context on.';

    if (input.clear) {
      return withInstanceWrite(agent, { site: 'set_thread_context#clear', kind: 'change', store: 'threads', target: () => [['thread', threadId]], main: ['thread'] }, (w) => {
        w.run('thread', () => threads.updateThread(threadId, { primary_subject_id: null }), ifTrue);
        return "Cleared this thread's project/client context.";
      });
    }

    const project = input.project?.trim();
    const customer = input.customer?.trim();
    if (!project && !customer) {
      return 'Error: pass a project and/or customer to set the thread context, or clear:true to remove it.';
    }

    try {
      return withInstanceWrite(agent, { site: 'set_thread_context#set', kind: 'change', store: 'threads', target: () => [['thread', threadId]], main: ['thread'] }, (w) => {
        let customerId: string | null = null;
        if (customer) {
          // Organizations ARE name-deduped → idempotent by name.
          // Setting a thread's customer is an explicit user act, so an unidentifying name
          // is worth saying out loud rather than binding to whichever one came first.
          const r = w.run('customer', () => subjects.findOrCreate({ kind: 'organization', name: customer }), ifCreated);
          if (r.ambiguous) return ambiguityText(subjects, r.candidateIds);
          customerId = r.id;
        }

        let anchorId: string;
        let label: string;
        let clientNote = '';
        if (project) {
          // The handler names the resolved client back to the user (below), so a
          // client-less project may reuse an existing client-parented row (a guess the
          // human sees + can correct). Extraction never does this — isolation guard.
          anchorId = w.run('project', () => subjects.findOrCreateEngagement(project, customerId, { allowParentedReuseOnNullParent: true }), ifCreated).id;
          if (customer) {
            label = `project "${project}" for client "${customer}"`;
          } else {
            // No client was named — if the resolved project is filed under one,
            // name it so the scope isn't silently attributed to another client.
            const parentId = subjects.getSubject(anchorId)?.parent_id ?? null;
            const parentName = parentId ? subjects.getSubject(parentId)?.name : undefined;
            // The client's stored name, in a marked block after the sentence: it can be extracted text.
            label = `project "${project}"`;
            if (parentName) clientNote = ` It is filed under a client whose stored name is:\n${wrapUntrustedData(parentName, 'set_thread_context')}`;
          }
        } else {
          // customer-only: customer is set (the both-empty case was rejected above).
          if (!customerId) {
            return 'Error: pass a project and/or customer to set the thread context.';
          }
          anchorId = customerId;
          label = `client "${customer}"`;
        }

        // history.db write last (cross-DB — no shared transaction with the subject writes).
        w.run('thread', () => threads.updateThread(threadId, { primary_subject_id: anchorId }), ifTrue);
        return `This thread is now scoped to ${label}. Notes saved here and recall will prefer this context.${clientNote}`;
      });
    } catch (e: unknown) {
      logErrorChain('set_thread_context', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
