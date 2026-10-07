import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The wire between the run claim in the engine and the library view that holds its key
 * (PRD idempotency-bulk-first §3.1/§3.3).
 *
 * ⛔ WHY THIS FILE EXISTS, and it is the one failure mode nothing else here can see: the
 * field NAME is the whole mechanism. Rename it on either side and the route finds no key,
 * takes no claim, and silently falls back to the old behaviour — no error, no red, every
 * test on both sides still green, and the feature gone. A type cannot cross an HTTP
 * boundary, and the lifecycle test beside this one never names the field.
 *
 * Second, the CODES. Before the claim existed every non-ok answer landed in the view's
 * error branch and read "run failed", so a correctly reported "already running" would
 * have shown as a failure — the exact defect `run-now-refusal-i18n.test.ts` was written
 * for one route over. The two 409s that mean "your attempt is alive" must be the two the
 * view keeps the key on; the others must not be, or a key nobody can clear hangs at 409.
 *
 * Source-level because a Svelte component cannot be imported in vitest here (the root
 * config has no svelte plugin). What this does NOT check: that the toast appears, or that
 * the German and the English say the same thing — the second is a reading, and both are
 * written natively rather than translated.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEW = readFileSync(`${HERE}WorkflowLibraryView.svelte`, 'utf8');
/**
 * `runWorkflow`'s own text, and every assertion about the request is made inside it.
 *
 * ⚠ Without this slice the body regex matched the SCHEDULE request forty lines earlier and
 * ran on for 43 lines, so "the view's request body" was really "anything in that stretch".
 * A mutant that renamed the wire field and planted a decoy `idempotencyKey:` in the
 * unrelated `/tasks` body survived it.
 */
/** The notice composer, which now owns every sentence the outcome branches show. */
const NOTICE = readFileSync(`${HERE}../utils/run-notice.ts`, 'utf8');
const RUN_FN = ((): string => {
  const from = VIEW.indexOf('async function runWorkflow(');
  const to = VIEW.indexOf('\n\tfunction startRename(', from);
  if (from < 0 || to < 0) throw new Error('runWorkflow not found — this test cannot judge anything');
  return VIEW.slice(from, to);
})();
const I18N = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');
const ROUTE = readFileSync(`${HERE}../../../../../src/server/http-api.ts`, 'utf8');

describe('the run claim reaches the view that holds its key', () => {
  it('both sides name the key field identically', () => {
    // ⚠ The field NAME is derived from the ROUTE and then required of the view, rather
    // than written twice here. The claim being tested IS their equality, so a literal on
    // each side would pass while they disagreed with a third spelling — and a rename on
    // the route alone would go unnoticed.
    const field = /\(body as Record<string, unknown>\)\['(\w+)'\];?\s*\n\s*if \(rawKey/.exec(ROUTE);
    expect(field, "the route has to read a key field out of the body").not.toBeNull();
    const name = field![1]!;

    // ⚠ And it is required as a PROPERTY, not as an identifier. The first version of this
    // line matched `/body: JSON.stringify\([^)]*idempotencyKey/`, and a mutant that
    // renamed the wire field to `{ runKey: idempotencyKey }` SURVIVED it — the identifier
    // was still there, as the VALUE. That is the exact defect this file was written to
    // catch, so the regex now anchors on the property position: shorthand `{ …, name }`
    // or explicit `name:`, never `other: name` (memory/fb_proxy_not_property.md).
    const shorthand = new RegExp(`[{,]\\s*${name}\\s*[},]`);
    const explicit = new RegExp(`[{,]\\s*${name}\\s*:`);
    const body = /body: JSON\.stringify\(([\s\S]*?)\)\n/.exec(RUN_FN);
    expect(body, 'the run request has to send a JSON body').not.toBeNull();
    expect(
      shorthand.test(body![1]!) || explicit.test(body![1]!),
      `the run request's body must carry a property NAMED ${name}, not merely a variable of that name`,
    ).toBe(true);
    // and the match really is the run's own body, not a stretch of file that happens to
    // contain one: it has to be short, and it has to mention the key.
    expect(body![1]!.split('\n').length, 'the slice must be ONE body, not a stretch of file')
      .toBeLessThan(6);
  });

  it('every refusal code the route emits goes through the one masking emitter', () => {
    // Each code is required to sit INSIDE an `errorResponse(...)` argument list, not merely
    // within n characters of one. The first version allowed 400 characters of anything in
    // between, which a hand-written `jsonResponse` satisfies as soon as a comment grows —
    // and a comment at that exact spot did grow, by about that much, the same day. The
    // margin was a character count that production prose moves.
    for (const code of ['run_claim_in_flight', 'run_in_progress', 'run_outcome_unknown', 'run_claim_held']) {
      const calls = [...ROUTE.matchAll(/errorResponse\(\s*([\s\S]*?)\);\n/g)]
        .map(m => m[1] ?? '')
        .filter(args => args.includes(`'${code}'`));
      expect(calls.length, `${code} has to be emitted by errorResponse, not a hand-written body`)
        .toBeGreaterThan(0);
      // and nowhere else: a second emitter for the same code is the hand-written body this
      // guards against.
      const emitters = ROUTE.split(`'${code}'`).length - 1;
      expect(emitters, `${code} is emitted ${emitters}× and ${calls.length}× through errorResponse`)
        .toBe(calls.length);
    }
  });

  it('the view DELEGATES the keep-or-clear decision instead of branching on codes itself', () => {
    // ⚠ This replaced three assertions over the component's text, and the reason is that
    // they killed nothing: `let keepKey = true` (never clear) and `keepKey = true` added to
    // the other 409 branch both survived them, because all they witnessed was that a
    // conditional clear EXISTED somewhere in the file. The rule now lives in
    // `run-attempt-key.ts` as a function of the answer and is driven exhaustively there.
    // What is left for a source check is the one thing a unit test cannot see: that this
    // component asks that function rather than deciding for itself.
    expect(RUN_FN, 'the 409 branch has to ask attemptIsOver')
      .toMatch(/keepKey = !attemptIsOver\(\{ httpStatus: 409, code: msg\?\.code \}\)/);
    // ⚠ TWICE, and counted. The `!res.ok` branch and the SUCCESS path each need their own,
    // and a single regex over the function was satisfied by either — so deleting the one on
    // the paying path survived, which is the mutant with the money in it: the key is then
    // never cleared after a successful run, the next click replays for ever, and the
    // workflow can never be run a second time.
    const narrowings = RUN_FN.match(/keepKey = !attemptIsOver\(\{ httpStatus: res\.status \}\)/g) ?? [];
    expect(narrowings.length, 'the !res.ok branch and the success path each need one').toBe(2);
    // And the success one sits AFTER the body is parsed: before it, a 200 whose body never
    // arrives would discard the key of a run that had already succeeded.
    const afterParse = RUN_FN.slice(RUN_FN.indexOf('await res.json()) as {'));
    expect(afterParse, 'the success path narrows only once the outcome is in hand')
      .toMatch(/keepKey = !attemptIsOver\(\{ httpStatus: res\.status \}\)/);
    expect(RUN_FN, 'the key is cleared only when the attempt is over')
      .toMatch(/if \(!keepKey\) clearAttemptKey\(id, params\)/);
    // No second decision path: `keepKey = true` may appear exactly ONCE, as the
    // declaration's initial value. A second one would be a branch deciding the key without
    // asking the function — which is the shape whose mutants survived.
    const setsTrue = RUN_FN.match(/keepKey = true/g) ?? [];
    expect(setsTrue.length, 'keepKey = true belongs only to the declaration').toBe(1);
    expect(RUN_FN).toMatch(/let keepKey = true/);
  });

  it('the DEFAULT is to keep the key, so an exit with no answer keeps it', () => {
    // The thrown-fetch case, and every future early return: `keepKey` starts true and is
    // only ever narrowed by an answer. Asserting the initial value is what makes the catch
    // block need no assignment of its own — and a mutant that flips it to `false` makes a
    // lost answer discard the key, which is the whole failure the key exists to prevent.
    expect(RUN_FN).toMatch(/let keepKey = true;/);
    const caught = RUN_FN.slice(RUN_FN.indexOf('} catch {'));
    expect(caught, 'the catch must not re-enable clearing').not.toMatch(/keepKey = false/);
  });

  it('both languages carry every sentence the new branches show', () => {
    // Reachability is checked across the VIEW and the NOTICE COMPOSER, because the outcome
    // sentences moved into the composer — a check against the view alone would have gone
    // red for a refactor and green for a genuinely orphaned key, i.e. wrong in both
    // directions. The keys are split by where they belong, so neither file can satisfy the
    // other's.
    const inView = ['run_already_running', 'run_outcome_unknown', 'run_claim_held'];
    const inComposer = ['run_done', 'run_failed', 'run_replayed', 'run_restarted_cost', 'run_restarted_free'];
    for (const [key, source, where] of [
      ...inView.map(k => [k, VIEW, 'the view'] as const),
      ...inComposer.map(k => [k, NOTICE, 'the notice composer'] as const),
    ]) {
      const line = I18N.split('\n').find(l => l.includes(`'workflow_library.${key}'`));
      expect(line, `workflow_library.${key} has to exist`).toBeDefined();
      expect(line!, `${key} needs German`).toMatch(/de: '[^']+'/);
      expect(line!, `${key} needs English`).toMatch(/en: '[^']+'/);
      expect(source, `${key} has to be reachable from ${where}`).toContain(`workflow_library.${key}`);
    }
  });

  it('no sentence shown next to a cost may end in a dangling label', () => {
    // The defect that produced "the earlier run already cost: ($0.1200)" about a run that
    // cost nothing: a sentence ending in a colon, with the NEXT value concatenated after
    // it. Checked on the strings themselves, in both languages, because the composition
    // cannot know what follows it.
    for (const key of ['run_done', 'run_failed', 'run_replayed', 'run_restarted_cost', 'run_restarted_free', 'run_already_running']) {
      const line = I18N.split('\n').find(l => l.includes(`'workflow_library.${key}'`))!;
      for (const lang of ['de', 'en']) {
        const m = new RegExp(`${lang}: '((?:[^'\\\\]|\\\\.)*)'`).exec(line);
        expect(m, `${key} needs a ${lang} string`).not.toBeNull();
        expect(m![1]!, `${key} (${lang}) ends in a label pointing at whatever follows`)
          .not.toMatch(/[:：]\s*$/);
      }
    }
  });

  it('the route sends the restart disclosure, and the composer owns the sentence', () => {
    // The two halves that cannot be seen from one file. The BEHAVIOUR of the sentence —
    // which form appears when, and that none of them promises a number it does not print —
    // is driven in `run-notice.test.ts`, with the real strings.
    expect(ROUTE, 'the route has to send it').toMatch(/restartedFrom: restartedFrom\.runId/);
    expect(ROUTE).toMatch(/previousCostUsd: restartedFrom\.costUsd/);
    expect(NOTICE, 'the composer branches on PRESENCE, not on a zero')
      .toMatch(/data\.restartedFrom === undefined/);
    expect(RUN_FN, 'and the view delegates the composition')
      .toMatch(/composeRunNotice\(data,/);
  });

  it('the local sentence WINS over the server message for the codes it knows', () => {
    // The route always sends an `error`, so a `msg?.error ?? t(…)` fallback never fires and
    // a German reader got the English sentence. The translation has to be chosen by code,
    // with the server's text kept only for a code this build does not know.
    expect(RUN_FN).toMatch(/run_claim_held'\s*\n?\s*\?\s*t\('workflow_library\.run_claim_held'\)/);
    expect(RUN_FN).toContain("t('workflow_library.run_outcome_unknown')");
    // ⚠ And the FALLBACK for an unknown 409 code is the cautious sentence, not "the run
    // failed": a 409 means the route refused, and a mangled or newer 409 must not be
    // reported as a failed run. One revision replaced that true sentence with a false one.
    //
    // Scoped to the 409 BRANCH, because `msg?.error ?? t('…run_failed')` is correct in the
    // `!res.ok` branch below it — a first version of this line forbade the pattern anywhere
    // in the function and so condemned the one place it belongs.
    const branch409 = RUN_FN.slice(
      RUN_FN.indexOf('if (res.status === 409)'),
      RUN_FN.indexOf('if (!res.ok)'),
    );
    expect(branch409.length, 'the 409 branch has to be found at all').toBeGreaterThan(100);
    // The CALL form, not the bare key: the branch's own comment explains why `run_failed`
    // is not used there, and a substring check counted that prose as a use. A text
    // instrument has to be told the difference between a call and a sentence about one.
    expect(branch409, 'an unknown 409 must not be reported as a failure')
      .not.toContain("t('workflow_library.run_failed')");
    // Positive control on the slice: it really is the branch, so the absence above means
    // something. (An empty or mis-sliced string would satisfy the negative assertion.)
    expect(branch409).toContain("t('workflow_library.run_outcome_unknown')");
  });
});
