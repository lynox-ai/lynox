import type { ToolEntry, IAgent } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import { runMerge } from '../../core/subject-merge-runner.js';
import { getErrorMessage } from '../../core/utils.js';
import { pv } from '../../core/prompt-value.js';

// Foundation Rework v2 — subject dedup (PR-C3). The chat-native surface over the
// SubjectStore.mergeSubjects primitive: when two person entries turn out to be the
// SAME real person ("Ada" and "Dr. Ada Lovelace"), fold the duplicate into the
// canonical — moving every note/task/mention/record onto it — via one confirmed call.
//
// Registered ONLY when `subject_graph_enabled` is on (engine.ts); absent otherwise.
// `requiresConfirmation: true` → the tool owns its own confirmation (promptUser), so a
// merge NEVER runs unattended: no interactive channel ⇒ it fails closed.
//
// Undoing one is possible but NOT from chat: `subject-sweep --rollback=<ledger>` against the
// file under `~/.lynox/sweeps/`. That file is in no backup and in neither migration list, so a
// restore or a tenant migration ends the possibility silently. Every user-facing string here —
// the description above, the consent prompt, the result — must say that plainly rather than the
// bare word "reversible", which is what all three used to say.

interface SubjectsMergeInput {
  duplicate: string;
  canonical: string;
}

export const subjectsMergeTool: ToolEntry<SubjectsMergeInput> = {
  requiresConfirmation: true,
  // A graph-wide repoint of every note/task/mention is destructive-class (like its
  // data-store/memory peers) — defense-in-depth so isDangerous flags it. The actual
  // hard refusal in autonomous mode lives in the handler (a self-confirming tool's
  // [BLOCKED] would otherwise route through the worker-wired promptUser as a
  // rubber-stampable notification, not a hard deny).
  destructive: { mode: 'data' },
  // The behavioural instruction lives here, not in `description`. `subjects_merge` is a
  // LAZY_DEFERRED tool, so its description is what tool-search matches against and wants to
  // stay keyword-rich (`agent.ts:111-112`) — while narrative prose in a definition rides the
  // cached prefix on every turn. `detailedGuidance` is the repo's purpose-built home for
  // exactly this split and is loaded only once the tool is actually reached.
  detailedGuidance:
    'Never tell the user a merge is reversible, undoable or can be rolled back from chat. It '
    + 'cannot: the rollback is a command-line step against a ledger file under ~/.lynox/sweeps/, '
    + 'and that file is in no backup and in neither migration list, so a restore or a tenant '
    + 'migration ends the possibility silently. Say what the result message says.',
  definition: {
    name: 'subjects_merge',
    description:
      'Merge two person entries that are the SAME real person into one (e.g. a bare first name "Ada" ' +
      'and the fuller "Dr. Ada Lovelace"), moving all their notes, tasks and mentions onto the kept entry. ' +
      'Use ONLY when confident they are one person. Pass the shorter/duplicate name as `duplicate` and the ' +
      'fuller/correct name as `canonical`. You will be asked to confirm. Undoing needs a command-line rollback from a ledger file that is not in any backup.',
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

    // A graph-wide repoint is not auto-safe: HARD-refuse in autonomous mode independent of a
    // wired promptUser. The worker loop wires promptUser to a notification, so relying on the
    // requiresConfirmation/[BLOCKED] path alone would let an injected instruction surface a
    // rubber-stampable "Merge X into Y?" — so we fail closed here (both autonomous and no-channel).
    if (agent.autonomy === 'autonomous' || !agent.promptUser) {
      return 'Error: merging people needs interactive confirmation and cannot run autonomously.';
    }
    // Subject names are KG-extracted from untrusted content, so a crafted name could inject
    // newlines/instructions or bidi/zero-width spoofing into the very approval text that
    // authorizes the repoint. Strip ALL Unicode format/invisible chars (\p{Cf} \u2014 covers the
    // bidi overrides + isolates, zero-width joiners/spaces, the Arabic letter mark, word
    // joiner, BOM, etc.), collapse whitespace to a single space (kills line-break injection),
    // and length-clamp before display.
    const clip = (n: string): string =>
      n.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 60);
    const dupSafe = clip(dup.name), canonSafe = clip(canon.name);
    // "This is reversible." used to end this sentence, and it was false three ways:
    // there is no undo the USER can reach (`rollbackMergeRun` has one non-test caller,
    // the `subject-sweep` CLI), and the ledger it needs lives in `~/.lynox/sweeps/`,
    // which is in NONE of `backup.ts`'s lists and in neither the migration export set
    // nor the import whitelist — so a migration, a restore or a container recreate
    // makes every past merge unreversible without anyone noticing.
    //
    // A consent prompt is the last thing a user reads before a destructive action, so
    // it is the wrong place to be aspirational. It now says the one thing that decides
    // their answer — they cannot take this back themselves — and leaves the operator
    // path to the result message, which hands over the actual ledger file.
    const answer = await agent.promptUser(
      pv`Merge "${dupSafe}" into "${canonSafe}"? Every note, task and mention of "${dupSafe}" moves to "${canonSafe}", and "${dupSafe}" is archived. Undoing it needs a command-line rollback — not something you can do from chat.`,
      ['Merge', 'Cancel'],
    );
    if (answer !== 'Merge') return `Cancelled — "${dup.name}" and "${canon.name}" were left as separate entries.`;

    try {
      const r = runMerge(subjects, agent.toolContext.dataStore, agent.toolContext.threadStore, getLynoxDir(), dup.id, canon.id);
      if (!r.ok) return `Merge refused: ${r.reason}`;
      const cells = r.dataStoreRows > 0 ? `, ${r.dataStoreRows} record cell${r.dataStoreRows === 1 ? '' : 's'} repointed` : '';
      // `runMerge` has always returned `ledgerPath` and this line always threw it
      // away, then claimed reversibility in the abstract. Handing over the actual
      // file is what turns "reversible" from a promise into an address: it is the
      // only input `rollbackMergeRun` takes, and it is NOT covered by backup or
      // migration — so a user who might ever want this undone needs to keep it.
      return `Merged "${r.dupName}" into "${r.canonicalName}" — one person now${cells}. `
        + `An operator can reverse this from ${r.ledgerPath} — that file is not included in backups, so keep it if this may need undoing.`;
    } catch (err) {
      return `subjects_merge error: ${getErrorMessage(err)}`;
    }
  },
};
