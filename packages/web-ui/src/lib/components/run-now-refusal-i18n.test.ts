import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The wire between the engine's refusal CODE and a sentence the owner can read.
 *
 * `POST /api/triggers/:id/run` has two different 409s: a run that is in flight, and a
 * trigger parked on a question the owner has not answered. They want opposite next moves
 * — wait, or go and answer it — and the engine distinguishes them with a `code` in the
 * body.
 *
 * ⛔ WHY THIS FILE EXISTS. The view's 409 branch showed ONE fixed string and never read
 * the body, so the second sentence was composed in `http-api.ts` and shown to nobody: the
 * owner of a parked trigger was told "Trigger läuft bereits." about a run that was not
 * running. A review round found it by reading the only caller. The engine half and the
 * view half have to AGREE, and a behavioural test of either alone cannot see the
 * disagreement — which is the same reason, and the same instrument, as
 * `cap-note-i18n.test.ts` beside it.
 *
 * Source-level because a Svelte component cannot be imported in vitest (the root config
 * has no svelte plugin).
 *
 * ⚠ What this does NOT check: that the toast is shown, or that the German and the English
 * say the same thing — the second is a reading, and both languages are written natively
 * here rather than translated from one another.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEW = readFileSync(`${HERE}TriggersView.svelte`, 'utf8');
const I18N = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');
const ROUTE = readFileSync(`${HERE}../../../../../src/server/http-api.ts`, 'utf8');

describe('the Run-now refusal reaches its owner', () => {
  it('the engine sends a code, the view switches on it, and both languages have the line', () => {
    // The engine half, asserted on the MECHANISM rather than the spelling: an earlier
    // version of this line matched the literal `code: 'awaiting_answer'` in a hand-built
    // body, and it broke the moment the route was corrected to go through
    // `errorResponse` — which is where masking and capping live. What has to hold is
    // that the refusal carries the code at all, and that the one emitter supports it.
    expect(ROUTE, 'the refusal has to pass a code').toMatch(/errorResponse\([^)]*'awaiting_answer'\)/);
    expect(ROUTE, 'and the single emitter has to carry one through').toMatch(/function errorResponse\([^)]*code\?: string/);
    // The view half: it reads the body and branches. Asserting the branch rather than
    // the mere presence of the word — a key named in a comment would satisfy a
    // substring check while the handler still showed one fixed string.
    expect(VIEW).toMatch(/res\.json\(\)[\s\S]{0,200}?code === 'awaiting_answer'/);
    expect(VIEW).toContain("'triggers.run_awaiting_answer'");
    // And the key exists in both languages, or the branch renders a raw key.
    const line = /'triggers\.run_awaiting_answer':\s*\{([\s\S]*?)\},/.exec(I18N);
    expect(line, 'the i18n entry has to exist at all').not.toBeNull();
    expect(line![1]).toMatch(/\bde:\s*'[^']{20,}'/);
    expect(line![1]).toMatch(/\ben:\s*'[^']{20,}'/);
  });

  it('and the OTHER 409 still has its own line — the branch distinguishes two answers', () => {
    // The positive control for the switch: with only one key present, a view that always
    // picked the new sentence would pass the test above and be wrong in the commoner case.
    expect(VIEW).toContain("'triggers.run_already'");
    expect(I18N).toContain("'triggers.run_already':");
    // The route must NOT stamp a code on the already-running refusal, or the view's
    // default branch becomes unreachable.
    // The branch may answer in more than one form (with the time a start can go through, or
    // without); every form must leave the code out — a fourth argument that is absent or
    // `undefined`.
    const start = ROUTE.indexOf("if (outcome.reason === 'already_running') {");
    expect(start, 'the already-running branch is still there').toBeGreaterThan(-1);
    const branch = ROUTE.slice(start, ROUTE.indexOf('return;', start));
    const answers = [...branch.matchAll(/errorResponse\(res, 409, (?:'[^']*'|`[^`]*`)(?:, ([^,)]+))?/g)];
    expect(answers.length, 'the branch still answers with a 409').toBeGreaterThan(0);
    // Every answer in the branch has to be one the pattern read: a form it cannot match (a
    // message in a variable, an apostrophe in a quoted one) would otherwise pass unchecked.
    expect(answers.length, 'an errorResponse in the branch has a form this check cannot read').toBe(branch.split('errorResponse(').length - 1);
    for (const m of answers) expect(m[1] === undefined || m[1].trim() === 'undefined', `a 409 in the already-running branch stamps a code: ${m[0]}`).toBe(true);
  });
});
