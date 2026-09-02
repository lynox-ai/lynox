import type { ToolEntry, IAgent } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import { runMerge, LEDGER_RETENTION_DAYS } from '../../core/subject-merge-runner.js';
import { getErrorMessage } from '../../core/utils.js';
import { pv } from '../../core/prompt-value.js';
import { NAME_DEDUPED_SUBJECT_KINDS } from '../../core/subject-store.js';
import type { SubjectKind } from '../../core/subject-store.js';

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
// file under `~/.lynox/sweeps/`. What makes it un-promisable is the ACCESS it needs — a shell on
// the machine — not the file's fragility. Every user-facing string here (the description, the
// consent prompt, the result) must say that plainly rather than the bare word "reversible".
//
// ⚠ These strings used to say the ledger "is in no backup and in neither migration list, so a
// restore or a tenant migration ends the possibility silently". That was true when written and
// is now FALSE in both halves: `data-dir-inventory.ts` declares `sweeps` as
// `{ backup: true, migrate: true }`. The ledger survives both. Nobody updated the prose when the
// inventory changed, so the tool was telling users the exact capability that had just been built
// for them did not exist — and asking them to preserve a file that is already preserved.

/**
 * The kinds this tool can fold: the name-deduped set, imported rather than restated.
 * Those are exactly the kinds whose identity IS their name, so two rows of one kind
 * sharing a name are the duplicate this tool exists to resolve; an engagement
 * (provider×client×period) or an `other` has no name-identity and must not be merged
 * by name. Re-declaring the list here would be a second source of truth that drifts
 * silently the day a kind joins or leaves the deduped set.
 *
 * It was `person`-only until a security round showed why that is not a safe default:
 * `organization` is the durable-knowledge write path's DEFAULT kind and made up the bulk
 * of a real graph, so the only user-reachable merge surface could not name most of what
 * it needed to fix.
 */

interface SubjectsMergeInput {
  duplicate: string;
  canonical: string;
  kind?: string | undefined;
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
    + 'and it needs shell access to the machine, which a chat user does not have. The ledger '
    + 'itself is durable — it is carried by both backup and migration — so do NOT tell the user '
    + 'the possibility disappears on a restore. Say what the result message says.',
  definition: {
    name: 'subjects_merge',
    description:
      'Merge two entries that are the SAME real thing into one (e.g. "Ada" and "Dr. Ada Lovelace"), ' +
      'moving all their notes, tasks and mentions onto the kept entry. Use ONLY when confident they ' +
      'are one. Pass the shorter/duplicate name as `duplicate`, the fuller one as `canonical`, and ' +
      '`kind` if they are not people. You will be asked to confirm. It cannot be undone from chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        duplicate: { type: 'string', description: 'The duplicate to fold away (kept as an alias of the canonical).' },
        canonical: { type: 'string', description: 'The correct / fuller entry to keep.' },
        kind: { type: 'string' as const, enum: [...NAME_DEDUPED_SUBJECT_KINDS], description: 'Defaults to person.' },
      },
      required: ['duplicate', 'canonical'],
    },
  },
  handler: async (input: SubjectsMergeInput, agent: IAgent): Promise<string> => {
    const subjects = agent.toolContext.subjectStore;
    if (!subjects) return 'Error: subject merge is not available (subject graph disabled).';

    const dupName = input.duplicate?.trim();
    const canonName = input.canonical?.trim();
    if (!dupName || !canonName) return 'Error: pass both `duplicate` and `canonical` names.';

    const rawKind = input.kind?.trim() || 'person';
    if (!(NAME_DEDUPED_SUBJECT_KINDS as readonly string[]).includes(rawKind)) {
      return `Error: \`kind\` must be one of ${NAME_DEDUPED_SUBJECT_KINDS.join(', ')}.`;
    }
    const kind = rawKind as SubjectKind;

    // Resolve each name to a single active subject of that kind (canonical name → alias).
    // A name SEVERAL entries answer to resolves to nothing here on purpose — which was
    // meant is not a question to guess before a graph-wide repoint. (A name that is one
    // entry's canonical name and another's alias is not that case: `findCanonical` runs
    // first and answers it, deliberately.)
    const dup = subjects.findCanonical(dupName, kind) ?? subjects.findByAlias(dupName, kind);
    if (!dup) return `Error: no ${kind} named "${dupName}" found in the knowledge graph.`;
    const canon = subjects.findCanonical(canonName, kind) ?? subjects.findByAlias(canonName, kind);
    if (!canon) return `Error: no ${kind} named "${canonName}" found in the knowledge graph.`;
    if (dup.id === canon.id) return `"${dupName}" and "${canonName}" are already the same ${kind} — nothing to merge.`;

    // A graph-wide repoint is not auto-safe: HARD-refuse in autonomous mode independent of a
    // wired promptUser. The worker loop wires promptUser to a notification, so relying on the
    // requiresConfirmation/[BLOCKED] path alone would let an injected instruction surface a
    // rubber-stampable "Merge X into Y?" — so we fail closed here (both autonomous and no-channel).
    if (agent.autonomy === 'autonomous' || !agent.promptUser) {
      return 'Error: merging entries needs interactive confirmation and cannot run autonomously.';
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
      // only input `rollbackMergeRun` takes. It IS covered by backup and migration
      // (`data-dir-inventory.ts`), so the honest limit is the access it needs, not
      // the file's survival — the previous wording had that exactly backwards.
      return `Merged "${r.dupName}" into "${r.canonicalName}" — one entry now${cells}. `
        + `An operator can reverse this from ${r.ledgerPath} — that needs shell access to this machine, not chat. The file is kept in backups and carried across migrations, and is removed after ${String(LEDGER_RETENTION_DAYS)} days.`;
    } catch (err) {
      return `subjects_merge error: ${getErrorMessage(err)}`;
    }
  },
};
