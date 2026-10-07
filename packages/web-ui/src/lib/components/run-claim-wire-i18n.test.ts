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
    expect(RUN_FN, 'and so does every other non-ok status — res.ok is NOT the discriminator')
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
    for (const key of ['run_already_running', 'run_outcome_unknown', 'run_claim_held', 'run_replayed', 'run_restarted']) {
      const line = I18N.split('\n').find(l => l.includes(`'workflow_library.${key}'`));
      expect(line, `workflow_library.${key} has to exist`).toBeDefined();
      expect(line!, `${key} needs German`).toMatch(/de: '[^']+'/);
      expect(line!, `${key} needs English`).toMatch(/en: '[^']+'/);
      expect(VIEW, `${key} has to be reachable from the view`).toContain(`workflow_library.${key}`);
    }
  });

  it('a restart is DISCLOSED in both outcome branches, with the earlier cost', () => {
    // The field the route sends only on a restart, and the sentence that makes a second
    // paid run visible as one. Appended in the completed AND the failed branch — a restart
    // whose new run also fails still spent the earlier money.
    expect(ROUTE, 'the route has to send it').toMatch(/restartedFrom: restartedFrom\.runId/);
    expect(ROUTE).toMatch(/previousCostUsd: restartedFrom\.costUsd/);
    expect(RUN_FN, 'the view branches on its PRESENCE, not on a zero')
      .toMatch(/data\.restartedFrom !== undefined/);
    expect(RUN_FN).toContain('workflow_library.run_restarted');
    const done = RUN_FN.slice(RUN_FN.indexOf("data.status === 'completed'"));
    expect(done.slice(0, 600), 'the completed branch shows it').toMatch(/\$\{restarted\}/);
    expect(done, 'and so does the failed branch').toMatch(/run_failed'\)\}\$\{replayed\}\$\{restarted\}/);
  });

  it('the local sentence WINS over the server message for the codes it knows', () => {
    // The route always sends an `error`, so a `msg?.error ?? t(…)` fallback never fires and
    // a German reader got the English sentence. The translation has to be chosen by code,
    // with the server's text kept only for a code this build does not know.
    expect(RUN_FN).toMatch(/run_outcome_unknown'\s*\n?\s*\?\s*t\('workflow_library\.run_outcome_unknown'\)/);
    expect(RUN_FN).toMatch(/run_claim_held'\s*\n?\s*\?\s*t\('workflow_library\.run_claim_held'\)/);
    expect(RUN_FN, 'the server text stays as the fallback for an unknown code')
      .toMatch(/msg\?\.error \?\? t\('workflow_library\.run_failed'\)/);
  });
});
