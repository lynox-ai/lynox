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
  const AUTHORSHIP_EXEMPT: Record<string, string> = {
    'tools/builtin/plan-task.ts': 'presentation is assembled from pv fragments (joinPrompts)',
    'integrations/mail/tools/mail-send.ts': 'buildSendPreview returns a PromptText fragment',
    'integrations/mail/tools/mail-reply.ts': 'buildSendPreview returns a PromptText fragment',
    'integrations/google/google-sheets.ts': 'confirmMsg is declared `: PromptText`',
    'integrations/google/google-calendar.ts': 'confirmMsg is declared `: PromptText`',
    'integrations/google/google-drive.ts': 'confirmMsg is declared `: PromptText`',
    'core/agent.ts': 'effectiveSignal.warning is system-generated tier text — all-frame is the true claim',
  };

  it('never pass an argument whose authorship is undeclared', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = file.slice(SRC.length + 1);
      for (const call of source.matchAll(/\bpromptUser!?\(\s*([^\n]{0,60})/g)) {
        const arg = (call[1] ?? '').trim();
        // Declared authorship, in the three forms the codebase actually uses.
        if (arg.startsWith('pv`') || arg.startsWith('promptValue(')) continue;
        // A literal with no interpolation is wholly system-written.
        if ((arg.startsWith('`') || arg.startsWith("'") || arg.startsWith('"')) && !arg.includes('${')) continue;
        // Not a call at all. A DECLARATION reads `promptUser(fn: PromptUserFn…)`
        // — the accessor in session.ts — and an argument is never `name: Type`,
        // so the annotation is what separates the two without a filename list.
        if (/^[A-Za-z_$][\w$]*\s*[:?]/.test(arg)) continue;
        if (arg.startsWith(')') || arg.startsWith(':')) continue;
        if (AUTHORSHIP_EXEMPT[rel]) continue;
        const line = source.slice(0, call.index).split(LF).length;
        offenders.push(`${rel}:${line} — ${arg.slice(0, 40)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest — every entry must still be a caller', () => {
    // An exemption for a file that no longer calls promptUser is a hole waiting
    // for the next caller to fall into: the name stays, the reason rots, and the
    // rule above silently stops applying to whatever moves in.
    const callers = new Set<string>();
    for (const file of walk(SRC)) {
      if (/\bpromptUser!?\(/.test(readFileSync(file, 'utf8'))) callers.add(file.slice(SRC.length + 1));
    }
    for (const rel of Object.keys(AUTHORSHIP_EXEMPT)) {
      expect(callers.has(rel), `${rel} is exempt but no longer calls promptUser`).toBe(true);
    }
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
