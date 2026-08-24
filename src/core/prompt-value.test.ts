import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pv, promptValue, promptSegments, flattenPrompt, isPromptText, singleLine } from './prompt-value.js';

const LF = String.fromCharCode(0x0a);

describe('pv — the frame/value split', () => {
  it('marks every interpolation as a value and everything else as frame', () => {
    expect(promptSegments(pv`Share ${'f1'} with ${'bob@x.test'}?`)).toEqual([
      { kind: 'frame', text: 'Share ' },
      { kind: 'value', text: 'f1' },
      { kind: 'frame', text: ' with ' },
      { kind: 'value', text: 'bob@x.test' },
      { kind: 'frame', text: '?' },
    ]);
  });

  it('keeps a value whole no matter what it contains', () => {
    // The point of the structural version: nothing is stripped, collapsed or
    // escaped at build time. A multi-line value stays multi-line — the renderer
    // is what makes it inert, so the feature keeps its content.
    const nasty = `line1${LF}# heading${LF}> quote`;
    const segments = promptSegments(pv`Plan: ${nasty}`);
    expect(segments[1]).toEqual({ kind: 'value', text: nasty });
  });

  it('splices a nested pv instead of stringifying it', () => {
    // Lets a builder hand back a fragment without flattening its values into
    // unmarked text — which is how buildSendPreview stays composable.
    const inner = pv`from ${'alice@x.test'}`;
    expect(promptSegments(pv`Reply ${inner}?`)).toEqual([
      { kind: 'frame', text: 'Reply from ' },
      { kind: 'value', text: 'alice@x.test' },
      { kind: 'frame', text: '?' },
    ]);
  });

  it('merges adjacent frames and drops empty spans', () => {
    expect(promptSegments(pv`${''}a${''}b`)).toEqual([{ kind: 'frame', text: 'ab' }]);
  });

  it('treats a plain string as all frame', () => {
    expect(promptSegments('**Bold**')).toEqual([{ kind: 'frame', text: '**Bold**' }]);
    expect(promptSegments('')).toEqual([]);
  });

  it('flattens to exactly what an older client would have received', () => {
    const p = pv`Host: ${'example.test'} — ok?`;
    expect(flattenPrompt(p)).toBe('Host: example.test — ok?');
    expect(flattenPrompt('plain')).toBe('plain');
  });

  it('does not mistake a look-alike object for a built prompt', () => {
    // The brand is what stops a value that happens to be shaped like
    // {segments} from being spliced in as frame.
    expect(isPromptText({ segments: [{ kind: 'frame', text: 'x' }] })).toBe(false);
    expect(isPromptText(pv`x`)).toBe(true);
    expect(promptSegments(pv`v: ${{ segments: [{ kind: 'frame', text: 'evil' }] }}`)[1]?.kind).toBe('value');
  });

  it('promptValue wraps an assembled string as one value', () => {
    expect(promptSegments(promptValue('all of this is the value'))).toEqual([
      { kind: 'value', text: 'all of this is the value' },
    ]);
    expect(promptSegments(promptValue(''))).toEqual([]);
  });
});

describe('singleLine — kept for display, no longer the boundary', () => {
  it('collapses breaks and strips format characters', () => {
    expect(singleLine(`a${LF}b`)).toBe('a b');
    expect(singleLine(`a${String.fromCharCode(0x202e)}b`)).toBe('ab');
  });
});

/**
 * The guard that makes this structural rather than conventional.
 *
 * A tagged template cannot be forgotten INSIDE a `pv` call — every
 * interpolation is a value by construction. What can still be forgotten is the
 * `pv` itself: writing `promptUser(`...${x}...`)` passes a plain string, which
 * means "all frame" and silently gives the value the frame's privileges.
 *
 * So the rule is mechanical and checked here: a `promptUser` call whose first
 * argument is a template literal WITH an interpolation must be tagged. Prose
 * would not have survived the next caller — that is the whole lesson of the
 * three rounds that led here.
 */
describe('promptUser callers', () => {
  const SRC = join(import.meta.dirname, '..');

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path;
    }
  }

  it('never pass an untagged template literal with an interpolation', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      // The call site plus enough of the argument to see how it opens. An
      // untagged template starts with a backtick right after the paren; a
      // tagged one has `pv` in between.
      const calls = source.matchAll(/promptUser(?:!)?\(\s*(`(?:[^`\\]|\\.)*`)/g);
      for (const call of calls) {
        const literal = call[1] ?? '';
        if (literal.includes('${')) {
          const line = source.slice(0, call.index).split(LF).length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The two rules below key on TEMPLATE SYNTAX — an untagged literal with an
   * interpolation, inline or one hop away. That is a proxy for "carries
   * untrusted content", and it let through the case where the argument IS
   * untrusted content and never touched a template: `ask_user` forwarded the
   * agent's whole question as a bare parameter from #1084 (2026-07-28) until
   * this rule was written, four weeks later.
   *
   * So this rule asks the question the other two only approximate: **is the
   * authorship of this argument declared?** Every accepted form says who wrote
   * the text — `pv` (frame plus marked values), `promptValue` (all value), a
   * literal with no interpolation (all system). Anything else has to be listed
   * here with a reason, which is the direction that fails LOUD: a new caller is
   * an offender until someone writes down why it is not.
   */
  /**
   * An exemption is one of exactly two things, and it has to say which.
   *
   * `proof` — a pattern that must still match the file. A reason nothing checks
   * rots in place: rewriting `confirmMsg` from `pv` to string concatenation
   * leaves the reason's WORDS intact and its claim false, and the earlier
   * version of this list stayed green through exactly that.
   *
   * `gap` — the caller is NOT safe and we know it. Carrying it as a named,
   * registered gap is the honest form; carrying it as a reason that reads like
   * safety is how a list of exceptions becomes a list of lies.
   */
  const AUTHORSHIP_EXEMPT: Record<string, { proof: RegExp } | { gap: string }> = {
    'tools/builtin/plan-task.ts': { proof: /joinPrompts\(/ },
    'integrations/mail/tools/mail-send.ts': { proof: /const preview = buildSendPreview\(/ },
    // Not `buildSendPreview` — this one assembles its own `pv`. The first draft
    // gave both mail files the same proof and this test caught it, which is the
    // point: a reason copied from a neighbour is not a reason.
    'integrations/mail/tools/mail-reply.ts': { proof: /const preview = pv`/ },
    'integrations/google/google-sheets.ts': { proof: /confirmMsg:\s*PromptText/ },
    'integrations/google/google-calendar.ts': { proof: /confirmMsg:\s*PromptText/ },
    'integrations/google/google-drive.ts': { proof: /confirmMsg:\s*PromptText/ },
    // NOT safe, and the first version of this list claimed it was ("system-
    // generated tier text — all-frame is the true claim"). Measured: the string
    // comes from `_detectDanger`, which interpolates the agent-controlled
    // `preview` and `filePath` into a plain template — so a security decision
    // prompt carries an unmarked agent span, which is this row's own defect one
    // surface over. Migrating it means changing what `_detectDanger` RETURNS,
    // across many return sites, so it is registered rather than smuggled in here.
    'core/agent.ts': { gap: 'DEF-danger-warning-interpolates-unmarked-agent-text' },
  };

  /** Blank out comment bodies and string contents, keeping offsets intact. */
  function stripCommentsAndStrings(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
      .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
  }

  /**
   * The classifier, lifted out of the sweep so it can be tested on strings.
   *
   * While it lived inline it had no coverage of its own: the sweep only ever
   * runs over a tree where every caller is already correct, so ANY mutation of
   * these rules — widening the declaration skip until it eats ternaries,
   * dropping the optional-call form — left the suite green. A guard whose own
   * logic nothing exercises is the same defect it exists to prevent, one level
   * up. The cases below are the shapes that were measured slipping through.
   */
  function classifyArg(arg: string, before = ''): 'declared' | 'declaration' | 'undeclared' {
    const a = arg.trimStart();
    if (a.startsWith('pv`') || a.startsWith('promptValue(')) return 'declared';
    if ((a.startsWith('`') || a.startsWith("'") || a.startsWith('"')) && !a.slice(0, 200).includes('${')) return 'declared';
    // A declaration always has the COLON; a ternary never does.
    if (/^[A-Za-z_$][\w$]*\??\s*:/.test(a)) return 'declaration';
    if (a.startsWith(')')) return 'declaration';
    if (isForwarded(a, before)) return 'declared';
    return 'undeclared';
  }

  /**
   * A pass-through: `promptUser: (q, opts, m) => promptUser(q, opts, {…})`.
   *
   * The rule this guard enforces is "say who wrote this text". A wrapper writes
   * none — the argument is byte-identically the one its own caller passed.
   * Flagging it would demand a `pv` on a value nobody here authored, which is
   * not a declaration but a lie.
   *
   * ⚠ NARROW ON PURPOSE, and the narrowing is the whole safety argument. The
   * first version accepted any arrow whose first parameter was passed through,
   * which also accepts a LOCAL helper — `const ask = q => agent.promptUser(q, o)`
   * — and there the reasoning collapses: the sweep matches `promptUser(` only,
   * so it never inspects `ask(`Delete ${file}?`)` and the authorship question is
   * not moved one frame out, it is dropped. So the arrow must be the value of a
   * `promptUser` / `promptSecret` / `promptTabs` property, i.e. a callback
   * being handed to an agent, which is a shape a caller cannot invent by
   * accident and whose own caller is the swept tool.
   */
  function isForwarded(arg: string, before: string): boolean {
    const first = arg.split(',')[0]!.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(first)) return false;
    // The nearest enclosing arrow — required to be a prompt-callback property's
    // value, and required to call straight through: nothing statement-like may
    // sit between its `=>` and this call, so a body that computes a new string
    // first is not a forwarder however it names its locals.
    const params = /\b(?:promptUser|promptSecret|promptTabs)\s*:[^;{}]*?\(([^()]*)\)\s*(?::\s*[^=;{]+)?=>\s*[^;{}]*$/
      .exec(before)?.[1];
    if (params === undefined) return false;
    return params.split(',').map(p => p.trim().split(/[:?=]/)[0]!.trim())[0] === first;
  }

  it('classifies the argument shapes that were measured slipping through', () => {
    expect(classifyArg('pv`Do X with ${y}?`, opts')).toBe('declared');
    expect(classifyArg('promptValue(question), labels')).toBe('declared');
    expect(classifyArg("'a fixed sentence', opts")).toBe('declared');
    // Undeclared, all four measured against the earlier rules:
    expect(classifyArg('agentText, opts'), 'a bare parameter').toBe('undeclared');
    expect(classifyArg('flag ? rawQ : otherRawQ, opts'), 'a ternary').toBe('undeclared');
    expect(classifyArg("rawQuestion ?? '', opts"), 'a nullish default').toBe('undeclared');
    expect(classifyArg('agentText?.trim(), opts'), 'an optional chain').toBe('undeclared');
    expect(classifyArg('`Ask about ${topic}?`, opts'), 'an untagged template').toBe('undeclared');
    // The accessor in session.ts, which is not a call at all:
    expect(classifyArg('fn: PromptUserFn | null) {')).toBe('declaration');
  });

  it('accepts a pass-through wrapper — and only a real one', () => {
    // The wrapper spawn.ts builds so a child's prompt names the child. It writes
    // no text; demanding a `pv` on a value it did not author would be a lie.
    expect(classifyArg('q, opts, { ...origin, ...m })', 'promptUser: promptUser ? (q, opts, m) => promptUser('))
      .toBe('declared');

    // ⭐ The four ways the wrong rule would let real offenders through, each
    // measured against a version that actually did rather than imagined:
    expect(
      classifyArg('agentText, opts)', 'promptUser: promptUser ? (q, opts, m) => promptUser('),
      'a bare parameter that is NOT the one forwarded',
    ).toBe('undeclared');
    expect(
      classifyArg('q, opts)', 'const q = `Ask about ${topic}?`;\n  await agent.promptUser('),
      'a local that merely shares a parameter\'s name, with no arrow at all',
    ).toBe('undeclared');
    expect(
      classifyArg('q, opts)', 'promptUser: (q, opts, m) => { const x = 1; return promptUser('),
      'a body that does work first is not a forwarder, however it names its locals',
    ).toBe('undeclared');
    // ⭐⭐ The one the first version got wrong. A local helper looks exactly like
    // a forwarder, but the sweep matches `promptUser(` only — it never inspects
    // `ask(`Delete ${file}?`)`, so the authorship question is not moved one frame
    // out, it is dropped. The exemption is therefore tied to the arrow being a
    // prompt-CALLBACK, not merely an arrow.
    expect(
      classifyArg('q, o)', 'const ask = (q: string) => agent.promptUser('),
      'a local helper is not a callback handed to an agent',
    ).toBe('undeclared');
    // And a second parameter is not the forwarded one either.
    expect(classifyArg('opts, q)', 'promptUser: promptUser ? (q, opts, m) => promptUser(')).toBe('undeclared');
  });

  it('sees every call form, including the optional one', () => {
    expect('a.promptUser(x); a.promptUser!(y); a.promptUser?.(z);'.match(promptUserCalls())).toHaveLength(3);
    // And two calls on ONE line must both be seen — the shape that hid a raw
    // arm behind a migrated one.
    expect('const r = f ? await promptUser(pv`ok?`, o) : await promptUser(rawQ, o);'.match(promptUserCalls())).toHaveLength(2);
  });

  it('finds an undeclared caller in a source that has one', () => {
    // The sweep below only ever runs over a tree where every caller is already
    // correct, so neutering it — skipping everything, dropping a call form —
    // was invisible. These fixtures are the positive case a guard needs before
    // its green means anything.
    expect(findOffenders(new Map([['x/raw.ts', 'await agent.promptUser(agentText, opts);']]), {}))
      .toEqual(['x/raw.ts:1']);
    expect(findOffenders(new Map([['x/opt.ts', 'await agent.promptUser?.(agentText);']]), {}))
      .toEqual(['x/opt.ts:1']);
    expect(findOffenders(new Map([['x/two.ts', 'f ? promptUser(pv`a`, o) : promptUser(rawQ, o);']]), {}))
      .toEqual(['x/two.ts:1']);
    // …and stays quiet on the declared forms and on non-code.
    expect(findOffenders(new Map([['x/ok.ts', 'promptUser(pv`a ${b}`, o); // promptUser(raw)\nconst s = "promptUser(raw)";']]), {}))
      .toEqual([]);
    // An exemption silences it, which is the whole reason the list is audited.
    expect(findOffenders(new Map([['x/raw.ts', 'promptUser(agentText);']]), { 'x/raw.ts': { gap: 'DEF-x' } }))
      .toEqual([]);
  });

  it('reports an exemption whose reason stopped being true', () => {
    const files = new Map([['x/a.ts', 'promptUser(confirmMsg, o);']]);
    expect(checkExemptions(files, { 'x/a.ts': { proof: /confirmMsg: PromptText/ } }))
      .toEqual(['x/a.ts is exempt on a reason that is no longer true']);
    expect(checkExemptions(files, { 'x/a.ts': { proof: /promptUser\(/ } })).toEqual([]);
    expect(checkExemptions(new Map(), { 'x/gone.ts': { gap: 'DEF-x' } }))
      .toEqual(['x/gone.ts is exempt but no longer exists']);
    expect(checkExemptions(new Map([['x/b.ts', 'nothing here']]), { 'x/b.ts': { gap: 'DEF-x' } }))
      .toEqual(['x/b.ts is exempt but no longer calls promptUser']);
    expect(checkExemptions(files, { 'x/a.ts': { gap: 'not-a-row-id' } }))
      .toEqual(['x/a.ts declares a gap that does not name a register row']);
  });

  /**
   * ONE pattern, used by the sweep and by its own tests. It used to be written
   * twice — the test pinned its copy while the sweep kept another, so dropping
   * the optional-call form from the sweep passed. A guard tested through a
   * duplicate of itself is tested through nothing.
   */
  function promptUserCalls(): RegExp {
    return /\bpromptUser(?:!|\?\.)?\(/g;
  }

  /** The sweep, over an explicit map so it can be run against fixtures. */
  function findOffenders(
    files: ReadonlyMap<string, string>,
    exempt: Record<string, { proof: RegExp } | { gap: string }>,
  ): string[] {
    const found: string[] = [];
    for (const [rel, source] of files) {
      if (exempt[rel]) continue;
      const code = stripCommentsAndStrings(source);
      for (const call of code.matchAll(promptUserCalls())) {
        const arg = code.slice(call.index + call[0].length);
        if (classifyArg(arg, code.slice(0, call.index)) !== 'undeclared') continue;
        found.push(`${rel}:${source.slice(0, call.index).split(LF).length}`);
      }
    }
    return found;
  }

  /** The exemption audit, likewise. Returns one message per rotten entry. */
  function checkExemptions(
    files: ReadonlyMap<string, string>,
    exempt: Record<string, { proof: RegExp } | { gap: string }>,
  ): string[] {
    const problems: string[] = [];
    for (const [rel, entry] of Object.entries(exempt)) {
      const src = files.get(rel);
      if (src === undefined) { problems.push(`${rel} is exempt but no longer exists`); continue; }
      if (!promptUserCalls().test(src)) { problems.push(`${rel} is exempt but no longer calls promptUser`); continue; }
      if ('proof' in entry) {
        if (!entry.proof.test(src)) problems.push(`${rel} is exempt on a reason that is no longer true`);
      } else if (!/^DEF-[a-z0-9-]+$/.test(entry.gap)) {
        problems.push(`${rel} declares a gap that does not name a register row`);
      }
    }
    return problems;
  }

  it('never pass an argument whose authorship is undeclared', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = file.slice(SRC.length + 1);
      // Strip comments and string bodies first: the scan reads raw source, so a
      // commented-out call and a call quoted inside a message both registered as
      // offenders. Fail-loud, but noise in a guard is how a guard gets muted.
      offenders.push(...findOffenders(new Map([[rel, source]]), AUTHORSHIP_EXEMPT));
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest — still a caller, and the reason still true', () => {
    // Two ways an exemption rots: it outlives its caller, or the caller changes
    // underneath it and leaves a reason that reads correct and claims something
    // no longer true. The second was measured — rewriting a `pv` prompt to
    // string concatenation left the earlier version of this test green.
    const files = new Map<string, string>();
    for (const file of walk(SRC)) files.set(file.slice(SRC.length + 1), readFileSync(file, 'utf8'));
    expect(checkExemptions(files, AUTHORSHIP_EXEMPT)).toEqual([]);
  });

  it('never pass a variable built from an untagged template literal', () => {
    // The inline form is not the only way to lose the split — the Google and
    // mail callers assemble into a local first. Same rule, one hop further:
    // if a variable handed to promptUser was assigned an untagged template
    // with an interpolation anywhere in the file, that is the same defect.
    //
    // Heuristic by construction (no type info here), and it says so: it can
    // only see an assignment and a call in ONE file. That covers every shape
    // this repo actually uses, and the typed `PromptText` catches the rest at
    // the point where a caller tries to build the prompt.
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const call of source.matchAll(/promptUser(?:!)?\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
        const name = call[1];
        if (!name) continue;
        const assigned = new RegExp(`(?:const|let|var)?\\s*${name}(?::[^=]+)?\\s*=\\s*\`[^\`]*\\$\\{`);
        if (assigned.test(source)) {
          const line = source.slice(0, call.index).split(LF).length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line} (${name})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
