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
    const body = /body: JSON\.stringify\(([\s\S]*?)\)\n/.exec(VIEW);
    expect(body, 'the view has to send a JSON body').not.toBeNull();
    expect(
      shorthand.test(body![1]!) || explicit.test(body![1]!),
      `the view's request body must carry a property NAMED ${name}, not merely a variable of that name`,
    ).toBe(true);
  });

  it('every refusal code the route emits goes through the one masking emitter', () => {
    for (const code of ['run_claim_in_flight', 'run_in_progress', 'run_outcome_unknown', 'run_claim_held']) {
      expect(ROUTE, `${code} has to be emitted by errorResponse, not a hand-written body`)
        .toMatch(new RegExp(`errorResponse\\([\\s\\S]{0,400}?'${code}'`));
    }
  });

  it('the view keeps the key on exactly the two codes that mean the attempt is alive', () => {
    // The branch, not the mere presence of the words: a code named in a comment would
    // satisfy a substring check while the handler still showed one fixed string.
    expect(VIEW).toMatch(/code === 'run_claim_in_flight' \|\| [\s\S]{0,40}code === 'run_in_progress'/);
    const aliveBranch = VIEW.slice(
      VIEW.indexOf("code === 'run_claim_in_flight'"),
      VIEW.indexOf('} else {', VIEW.indexOf("code === 'run_claim_in_flight'")),
    );
    expect(aliveBranch, 'an alive attempt keeps its key').toMatch(/keepKey = true/);
    // And the other 409s must NOT keep it — a key that can never be cleared answers 409
    // for good. This is the assertion that fails if someone "fixes" the hang by keeping
    // the key everywhere.
    expect(VIEW).toMatch(/if \(!keepKey\) clearAttemptKey\(id\)/);
  });

  it('a thrown fetch keeps the key, because that is the case it exists for', () => {
    const caught = VIEW.slice(VIEW.indexOf('} catch {', VIEW.indexOf('async function runWorkflow')));
    expect(caught.slice(0, 400), 'an answer that never arrived must not discard the key')
      .toMatch(/keepKey = true/);
  });

  it('both languages carry every sentence the new branches show', () => {
    for (const key of ['run_already_running', 'run_outcome_unknown', 'run_replayed']) {
      const line = I18N.split('\n').find(l => l.includes(`'workflow_library.${key}'`));
      expect(line, `workflow_library.${key} has to exist`).toBeDefined();
      expect(line!, `${key} needs German`).toMatch(/de: '[^']+'/);
      expect(line!, `${key} needs English`).toMatch(/en: '[^']+'/);
      expect(VIEW, `${key} has to be reachable from the view`).toContain(`workflow_library.${key}`);
    }
  });
});
