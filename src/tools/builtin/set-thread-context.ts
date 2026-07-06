import type { ToolEntry, IAgent } from '../../types/index.js';
import { logErrorChain } from '../../core/utils.js';

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

export const setThreadContextTool: ToolEntry<SetThreadContextInput> = {
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
      threads.updateThread(threadId, { primary_subject_id: null });
      return "Cleared this thread's project/client context.";
    }

    const project = input.project?.trim();
    const customer = input.customer?.trim();
    if (!project && !customer) {
      return 'Error: pass a project and/or customer to set the thread context, or clear:true to remove it.';
    }

    try {
      let customerId: string | null = null;
      if (customer) {
        // Organizations ARE name-deduped → idempotent by name.
        customerId = subjects.findOrCreate({ kind: 'organization', name: customer }).id;
      }

      let anchorId: string;
      let label: string;
      if (project) {
        // The handler names the resolved client back to the user (below), so a
        // client-less project may reuse an existing client-parented row (a guess the
        // human sees + can correct). Extraction never does this — isolation guard.
        anchorId = subjects.findOrCreateEngagement(project, customerId, { allowParentedReuseOnNullParent: true }).id;
        if (customer) {
          label = `project "${project}" for client "${customer}"`;
        } else {
          // No client was named — if the resolved project is filed under one,
          // name it so the scope isn't silently attributed to another client.
          const parentId = subjects.getSubject(anchorId)?.parent_id ?? null;
          const parentName = parentId ? subjects.getSubject(parentId)?.name : undefined;
          label = parentName ? `project "${project}" for client "${parentName}"` : `project "${project}"`;
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
      threads.updateThread(threadId, { primary_subject_id: anchorId });
      return `This thread is now scoped to ${label}. Notes saved here and recall will prefer this context.`;
    } catch (e: unknown) {
      logErrorChain('set_thread_context', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
