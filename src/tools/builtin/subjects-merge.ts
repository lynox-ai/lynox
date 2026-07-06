import type { ToolEntry, IAgent } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import { runMerge } from '../../core/subject-merge-runner.js';
import { getErrorMessage } from '../../core/utils.js';

// Foundation Rework v2 — subject dedup (PR-C3). The chat-native surface over the
// SubjectStore.mergeSubjects primitive: when two person entries turn out to be the
// SAME real person ("Ada" and "Dr. Ada Lovelace"), fold the duplicate into the
// canonical — moving every note/task/mention/record onto it — via one confirmed call.
//
// Registered ONLY when `subject_graph_enabled` is on (engine.ts); absent otherwise.
// `requiresConfirmation: true` → the tool owns its own confirmation (promptUser), so a
// merge NEVER runs unattended: no interactive channel ⇒ it fails closed. Reversible via
// the shared merge runner's ledger (the same `~/.lynox/sweeps/` + `subject-sweep --rollback`
// path the operator sweep uses).

interface SubjectsMergeInput {
  duplicate: string;
  canonical: string;
}

export const subjectsMergeTool: ToolEntry<SubjectsMergeInput> = {
  requiresConfirmation: true,
  definition: {
    name: 'subjects_merge',
    description:
      'Merge two person entries that are the SAME real person into one (e.g. a bare first name "Ada" ' +
      'and the fuller "Dr. Ada Lovelace"), moving all their notes, tasks and mentions onto the kept entry. ' +
      'Use ONLY when confident they are one person. Pass the shorter/duplicate name as `duplicate` and the ' +
      'fuller/correct name as `canonical`. You will be asked to confirm; the merge is reversible.',
    input_schema: {
      type: 'object' as const,
      properties: {
        duplicate: { type: 'string', description: 'The duplicate person to fold away (kept as an alias of the canonical).' },
        canonical: { type: 'string', description: 'The correct / fuller person entry to keep.' },
      },
      required: ['duplicate', 'canonical'],
    },
  },
  handler: async (input: SubjectsMergeInput, agent: IAgent): Promise<string> => {
    const subjects = agent.toolContext.subjectStore;
    if (!subjects) return 'Error: subject merge is not available (subject graph disabled).';

    const dupName = input.duplicate?.trim();
    const canonName = input.canonical?.trim();
    if (!dupName || !canonName) return 'Error: pass both `duplicate` and `canonical` person names.';

    // Resolve each name to a single active person subject (canonical name → alias).
    const dup = subjects.findCanonical(dupName, 'person') ?? subjects.findByAlias(dupName, 'person');
    if (!dup) return `Error: no person named "${dupName}" found in the knowledge graph.`;
    const canon = subjects.findCanonical(canonName, 'person') ?? subjects.findByAlias(canonName, 'person');
    if (!canon) return `Error: no person named "${canonName}" found in the knowledge graph.`;
    if (dup.id === canon.id) return `"${dupName}" and "${canonName}" are already the same person — nothing to merge.`;

    // requiresConfirmation → confirm in the conversation. No promptUser channel
    // (autonomous / headless) ⇒ fail closed: a graph-wide repoint is not auto-safe.
    if (!agent.promptUser) {
      return 'Error: merging people needs interactive confirmation and cannot run autonomously.';
    }
    const answer = await agent.promptUser(
      `Merge "${dup.name}" into "${canon.name}"? Every note, task and mention of "${dup.name}" moves to "${canon.name}", and "${dup.name}" is archived. This is reversible.`,
      ['Merge', 'Cancel'],
    );
    if (answer !== 'Merge') return `Cancelled — "${dup.name}" and "${canon.name}" were left as separate entries.`;

    try {
      const r = runMerge(subjects, agent.toolContext.dataStore, getLynoxDir(), dup.id, canon.id);
      if (!r.ok) return `Merge refused: ${r.reason}`;
      const cells = r.dataStoreRows > 0 ? `, ${r.dataStoreRows} record cell${r.dataStoreRows === 1 ? '' : 's'} repointed` : '';
      return `Merged "${r.dupName}" into "${r.canonicalName}" — one person now${cells}. Reversible from the merge ledger.`;
    } catch (err) {
      return `subjects_merge error: ${getErrorMessage(err)}`;
    }
  },
};
