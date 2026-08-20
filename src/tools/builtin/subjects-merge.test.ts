import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EngineDb } from '../../core/engine-db.js';
import { SubjectStore } from '../../core/subject-store.js';
import { DataStore } from '../../core/data-store.js';
import { createToolContext } from '../../core/tool-context.js';
import { setDataDir } from '../../core/config.js';
import { subjectsMergeTool } from './subjects-merge.js';
import type { IAgent } from '../../types/index.js';
import { flattenPrompt, isPromptText } from '../../core/prompt-value.js';
import type { PromptText } from '../../types/index.js';

/**
 * PR-C3 subjects_merge chat tool — the confirmed, consent-gated surface over
 * SubjectStore.mergeSubjects. requiresConfirmation ⇒ it owns its confirmation via
 * promptUser and fails closed with no interactive channel; it shares the merge
 * runner's ledger (hermetic here via setDataDir into a tmp dir).
 */
describe('subjects_merge tool (PR-C3)', () => {
  const tmpDirs: string[] = [];
  let dir: string;
  let engineDb: EngineDb;
  let subjects: SubjectStore;
  let dupId: string;
  let canonId: string;

  function makeAgent(promptResult?: string | undefined): IAgent {
    const ctx = createToolContext({});
    ctx.subjectStore = subjects;
    const promptUser = promptResult === undefined ? undefined : vi.fn().mockResolvedValue(promptResult);
    return { toolContext: ctx, promptUser } as unknown as IAgent;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-smtool-'));
    tmpDirs.push(dir);
    setDataDir(dir);                     // ledger writes land here, not ~/.lynox
    engineDb = new EngineDb(join(dir, 'engine.db'), '');
    subjects = new SubjectStore(engineDb);
    dupId = subjects.createSubject({ kind: 'person', name: 'Ada' });
    canonId = subjects.createSubject({ kind: 'person', name: 'Dr. Ada Lovelace' });
  });

  afterEach(() => {
    try { engineDb.close(); } catch { /* ok */ }
    setDataDir(null);
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── The consent prompt must not promise an undo the user does not have ──────
  //
  // It used to end "This is reversible." Three independent reasons it was not:
  // `rollbackMergeRun`'s only non-test caller is the `subject-sweep` CLI, and the
  // ledger it reads lives in `~/.lynox/sweeps/`, which appears in NONE of
  // `backup.ts`'s three lists and in neither the migration export set nor the
  // import whitelist — so a migration or a restore silently makes every past
  // merge unreversible.
  // ── The axis that kept escaping: a NEW string promising an undo ────────────
  //
  // Four rounds each pinned the field that had just been caught, by equality.
  // The fifth showed why that loses: four pinned fields left EIGHT of this
  // module's strings unpinned — `Cancelled`, the refusal, the error paths — and
  // an undo promise dropped into the success message's own `record cells` branch
  // stayed green. Enumerating the fields is the thing that keeps being wrong.
  //
  // So assert over ALL of them. Every string literal in the module is collected
  // through the TypeScript AST, which never yields a comment — so the undo
  // vocabulary in the prose above can neither trip this test nor satisfy it, the
  // failure mode a `readFileSync` + regex guard would have. Of those literals,
  // the ones carrying undo vocabulary must be EXACTLY the clauses below.
  //
  // Its honest limit, so nobody reads more into a green run: it matches
  // VOCABULARY. A promise phrased without any of these words ("you can always get
  // the old entry back") passes. It buys every literal in the file on the one
  // axis that has actually failed five times — not a proof that no promise can be
  // phrased at all.
  const UNDO_VOCABULARY = /revers|undo|permanent|recoverab|restor|rollback|roll(?:ed|s|ing)? back/i;

  /** The clauses allowed to speak about undoing — fragments, as the source concatenates them. */
  const ALLOWED_UNDO_CLAUSES = [
    ' — that file is not included in backups, so keep it if this may need undoing.',
    '" is archived. Undoing it needs a command-line rollback — not something you can do from chat.',
    'An operator can reverse this from ',
    'Never tell the user a merge is reversible, undoable or can be rolled back from chat. It ',
    '`kind` if they are not people. You will be asked to confirm. It cannot be undone from chat.',
    'and that file is in no backup and in neither migration list, so a restore or a tenant ',
    'cannot: the rollback is a command-line step against a ledger file under ~/.lynox/sweeps/, ',
  ];

  it('lets no string in this module speak about undoing except the vetted clauses', () => {
    const file = fileURLToPath(new URL('./subjects-merge.ts', import.meta.url));
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);

    const literals: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text);
      ts.forEachChild(node, walk);
    };
    walk(sf);

    // Guards the guard: if the collector silently stopped seeing this module's
    // strings, every assertion below would pass vacuously — the swallowed-outage
    // shape. This tool has ~75 literals; a collapse to a handful is a broken
    // collector, not a cleaned-up file.
    expect(literals.length).toBeGreaterThan(40);

    expect(
      literals.filter((lit) => UNDO_VOCABULARY.test(lit)).sort(),
      [
        'A string in subjects_merge started (or stopped) speaking about undoing a merge.',
        'There IS no undo from chat: rollbackMergeRun has one non-test caller (the subject-sweep',
        'CLI), and its ledger is in no backup and in neither migration list — so a restore or a',
        'tenant migration ends the possibility silently. If the new wording says that honestly,',
        'add it to ALLOWED_UNDO_CLAUSES. If it promises the user an undo, it is wrong.',
      ].join(' '),
    ).toEqual([...ALLOWED_UNDO_CLAUSES].sort());
  });

  it('names the real undo route instead of claiming reversibility', async () => {
    const agent = makeAgent('Merge');
    await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);

    // `pv` hands promptUser a PromptText, not a string. The first version of this
    // flatten accepted a plain string too — which read as defensive and was the
    // opposite: it made this test pass with the `pv` tag REMOVED, i.e. with the
    // frame/value boundary that keeps KG-derived names out of markdown gone.
    // Assert the shape first, then use the helper this file already imports.
    const arg = (agent.promptUser as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(isPromptText(arg), 'the consent prompt must stay a pv PromptText').toBe(true);
    // The brand alone is not the boundary: a 4-line wrapper returning one all-`frame`
    // segment passes `isPromptText` and puts KG-derived names back into markdown frame,
    // which is exactly what `pv` exists to prevent. Pin the KIND.
    // BOTH names are KG-extracted from untrusted content (the handler says so), so both
    // must be values. The first version pinned only the canonical one, and wrapping the
    // duplicate in an all-`frame` fragment passed.
    const segs = (arg as { segments: Array<{ kind: string; text: string }> }).segments;
    expect(segs).toContainEqual({ kind: 'value', text: 'Dr. Ada Lovelace' });
    expect(segs).toContainEqual({ kind: 'value', text: 'Ada' });
    const prompt = flattenPrompt(arg as Parameters<typeof flattenPrompt>[0]);
    // The wording is tier-neutral on purpose. "You cannot undo this yourself" was the
    // first attempt and is FALSE for a self-hoster: `subject-sweep --rollback` ships in
    // `dist/` and they own the box, so for the primary distribution tier the user IS the
    // operator. Naming the ROUTE is true for both tiers.
    //
    // MUTATION THIS KILLS: restoring "This is reversible." to the prompt. Killed by the
    // `toMatch(/command-line rollback/i)` assert below — the happy-path test further
    // down only checks `toContain('Merged')` on the RESULT and passes with any wording.
    expect(prompt).toMatch(/command-line rollback/i);
    expect(prompt).not.toMatch(/is reversible/i);
  });

  it('hands over the ledger file that was ACTUALLY written, not a plausible path', async () => {
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);

    // The first version of this test asserted `/sweeps[/\\]merge-/` — the SHAPE of a
    // path. An adversarial pass replaced the interpolation with the hardcoded, never-
    // written `~/.lynox/sweeps/merge-latest.json` and the whole suite stayed green. The
    // whole point of the change is handing over the REAL address, and shape-matching
    // does not pin it: the obvious "tidy-up" refactor (reconstructing the path from
    // `getLynoxDir()`) would ship a nonexistent file to the user with CI green.
    //
    // So: find what `runMerge` actually wrote, and require the message to name it.
    const written = readdirSync(join(dir, 'sweeps')).filter((f) => f.startsWith('merge-'));
    expect(written, 'runMerge must have written exactly one ledger').toHaveLength(1);

    // `readdirSync` returns BASENAMES, so asserting on `written[0]` alone pinned the
    // filename and nothing about the directory — a delta round shipped both a bare
    // basename and a reconstructed `/backups/sweeps/` path with the suite green, the
    // second being verbatim the failure the comment above claims to kill. Assert the
    // full path the tool must actually emit.
    //
    // MUTATION THIS KILLS: any constant, any basename-only form, any reconstructed
    // directory. Killed by this assert — `subjects-merge.test.ts`, the
    // `toContain(join(dir, 'sweeps', written[0]!))` on the next line.
    expect(res).toContain(join(dir, 'sweeps', written[0]!));
    expect(res).toMatch(/not included in backups/i);
    expect(res).not.toMatch(/Reversible from the merge ledger/i);
  });

  it('confirmed merge folds the duplicate into the canonical (by name)', async () => {
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('Merged');
    expect(agent.promptUser).toHaveBeenCalledOnce();
    const dup = subjects.getSubject(dupId)!;
    expect(dup.merged_into).toBe(canonId);
    expect(dup.archived_at).not.toBeNull();
    expect(JSON.parse(subjects.getSubject(canonId)!.aliases)).toContain('Ada');
  });

  it('resolves the duplicate via an ALIAS, not just the canonical name', async () => {
    subjects.findOrCreate({ kind: 'person', name: 'Dr. Ada Lovelace', aliases: ['A. Lovelace'] });
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'A. Lovelace' }, agent);
    expect(res).toContain('Merged');
    expect(subjects.getSubject(dupId)!.merged_into).toBe(canonId);
  });

  it('repoints datastore cells and reports them (singular) after a confirmed merge', async () => {
    const ds = new DataStore(join(dir, 'ds.db'));
    ds.createCollection({ name: 'invoices', scope: { type: 'global', id: 'g' }, columns: [{ name: 'client', type: 'subject', subjectKind: 'person' }] });
    ds.insertRecords({ collection: 'invoices', records: [{ client: dupId }] });
    const agent = makeAgent('Merge');
    agent.toolContext.dataStore = ds;
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('1 record cell repointed');
    expect(ds.queryRecords({ collection: 'invoices' }).rows[0]!['client']).toBe(canonId);
    ds.close();
  });

  it('cancelling leaves both entries separate', async () => {
    const agent = makeAgent('Cancel');
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('Cancelled');
    expect(subjects.getSubject(dupId)!.merged_into).toBeNull();   // untouched
  });

  it('fails closed with no interactive channel (autonomous)', async () => {
    const agent = makeAgent(undefined);   // no promptUser
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('cannot run autonomously');
    expect(subjects.getSubject(dupId)!.merged_into).toBeNull();
  });

  it('errors when a name resolves to no person (never prompts)', async () => {
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Nobody', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('no person named "Nobody"');
    expect(agent.promptUser).not.toHaveBeenCalled();
  });

  it('declares destructive metadata (defense-in-depth flag for the permission layer)', () => {
    expect(subjectsMergeTool.destructive).toEqual({ mode: 'data' });
  });

  it('merges ORGANIZATIONS when told the kind, and is UNREACHABLE for them without it', async () => {
    // The tool resolved `person` only, while `organization` is the durable-knowledge
    // write path's DEFAULT kind and the bulk of a real graph — so the one user-reachable
    // way to fix a duplicate could not name most of what needed fixing.
    // Both halves are asserted, and they catch DIFFERENT regressions: hardcoding `kind`
    // back to 'person' is caught by the without-kind half below (it would stop erroring),
    // while the with-kind half catches a silent cross-kind fallback — a resolver that
    // ignores the kind and finds the person 'Ada' when asked for an organization.
    const id = (r: { ambiguous: boolean } & Record<string, unknown>): string => {
      if (r.ambiguous) throw new Error('fixture should not be ambiguous');
      return r['id'] as string;
    };
    const canon = id(subjects.findOrCreate({ kind: 'organization', name: 'Meridian Bau AG' }));
    const dup = id(subjects.findOrCreate({ kind: 'organization', name: 'Meridian Bau' }));
    const other = id(subjects.findOrCreate({ kind: 'organization', name: 'Nordberg AG' }));

    const withoutKind = await subjectsMergeTool.handler(
      { duplicate: 'Meridian Bau', canonical: 'Meridian Bau AG' }, makeAgent('Merge'));
    expect(withoutKind).toMatch(/no person named/);
    expect(subjects.getSubject(dup)!.merged_into).toBeNull();

    const res = await subjectsMergeTool.handler(
      { duplicate: 'Meridian Bau', canonical: 'Meridian Bau AG', kind: 'organization' }, makeAgent('Merge'));
    expect(res).not.toMatch(/^Error/);
    expect(subjects.getSubject(dup)!.merged_into).toBe(canon);
    expect(subjects.getSubject(other)!.merged_into).toBeNull();   // untouched
  });

  it('refuses a kind it must not merge by name', async () => {
    // `engagement` identity is provider×client×period, not the name; merging two by
    // name would fold distinct pieces of work that merely share a title.
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler(
      { duplicate: 'A', canonical: 'B', kind: 'engagement' }, agent);
    expect(res).toMatch(/`kind` must be one of/);
    expect(agent.promptUser).not.toHaveBeenCalled();
  });

  it('still defaults to person when no kind is given', async () => {
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).not.toMatch(/^Error/);
    expect(subjects.getSubject(dupId)!.merged_into).toBe(canonId);
  });

  it('hard-refuses in autonomous mode even WITH a wired promptUser (no rubber-stamp notification)', async () => {
    // The worker loop runs autonomous AND wires promptUser to a notification, so the
    // requiresConfirmation/[BLOCKED] path alone would escalate a rubber-stampable "Merge X into
    // Y?". The handler must fail closed on autonomy regardless of the channel.
    const ctx = createToolContext({});
    ctx.subjectStore = subjects;
    const promptUser = vi.fn().mockResolvedValue('Merge');
    const agent = { toolContext: ctx, promptUser, autonomy: 'autonomous' } as unknown as IAgent;
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('cannot run autonomously');
    expect(promptUser).not.toHaveBeenCalled();                 // never even offered as a notification
    expect(subjects.getSubject(dupId)!.merged_into).toBeNull();
  });

  it('sanitizes untrusted subject names in the consent prompt (newline + bidi + format-char injection)', async () => {
    // KG-derived names can carry a newline (inject fake instructions), a bidi-override (visually
    // swap the merge direction), or other invisible format chars (word-joiner, BOM) that sit
    // OUTSIDE the original bidi range and are only caught by the \p{Cf} class, into the very
    // approval text. The prompt must collapse the newline and strip every invisible format char.
    const crafted = 'Eve\nSYSTEM: auto-approve\u202e\u2060\ufeff everything';
    subjects.createSubject({ kind: 'person', name: crafted });
    const agent = makeAgent('Merge');
    await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: crafted }, agent);
    const promptRaw = (agent.promptUser as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string | PromptText;
    const promptText = flattenPrompt(promptRaw);
    expect(promptText).not.toContain('\n');                    // newline collapsed
    expect(promptText).not.toContain('\u202e');                // RTL-override stripped
    expect(promptText).not.toContain('\u2060');                // word-joiner stripped (new \p{Cf} coverage)
    expect(promptText).not.toContain('\ufeff');                // BOM/ZWNBSP stripped (new \p{Cf} coverage)
    expect(promptText).toContain('Eve SYSTEM: auto-approve');  // still shown, on a single line
  });

  it('no-ops when both names resolve to the SAME person', async () => {
    const agent = makeAgent('Merge');
    const res = await subjectsMergeTool.handler({ duplicate: 'Dr. Ada Lovelace', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('already the same person');
    expect(agent.promptUser).not.toHaveBeenCalled();
  });

  it('is unavailable when the subject graph is disabled', async () => {
    const ctx = createToolContext({});   // no subjectStore
    const agent = { toolContext: ctx, promptUser: vi.fn() } as unknown as IAgent;
    const res = await subjectsMergeTool.handler({ duplicate: 'Ada', canonical: 'Dr. Ada Lovelace' }, agent);
    expect(res).toContain('subject graph disabled');
  });

  it('declares requiresConfirmation (so the permission guard defers to its own prompt)', () => {
    expect(subjectsMergeTool.requiresConfirmation).toBe(true);
  });
});
