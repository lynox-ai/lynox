import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The schedules view can stop a running run, and every answer of the stop route reaches
 * the owner as its own sentence.
 *
 * `POST /api/tasks/:id/stop` existed with no caller in the interface, so an owner could
 * stop a run only by API. The view now offers "Stop run" on a row the list reports as
 * running (`running` on `GET /api/triggers`) and calls the route. The route answers in
 * five ways the owner has to tell apart: requested (202), not theirs to stop (403), and
 * three 409s — the run ended since the list loaded, the run is in a phase nothing can
 * interrupt, the id names more than one task. The 409s differ only by `code`.
 *
 * Source-level for the same reason as `run-now-refusal-i18n.test.ts` beside it: a Svelte
 * component cannot be imported in vitest (the root config has no svelte plugin), and the
 * engine half and the view half have to AGREE — a behavioural test of either alone
 * cannot see a code one emits and the other never reads.
 *
 * ⚠ What this does NOT check: that the toast is shown, or that the German and the English
 * say the same thing.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEW = readFileSync(`${HERE}TriggersView.svelte`, 'utf8');
const I18N = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');
const ROUTE = readFileSync(`${HERE}../../../../../src/server/http-api.ts`, 'utf8');

const CODES = ['not_running', 'unstoppable', 'ambiguous_id'] as const;
const KEY_OF: Record<(typeof CODES)[number], string> = {
  not_running: 'triggers.stop_not_running',
  unstoppable: 'triggers.stop_unstoppable',
  ambiguous_id: 'triggers.stop_ambiguous',
};

/** The body of the stop route, from its registration to the next route. */
function stopRoute(): string {
  const start = ROUTE.indexOf("'POST', '/api/tasks/:id/stop'");
  expect(start, 'the stop route is still registered').toBeGreaterThan(-1);
  return ROUTE.slice(start, ROUTE.indexOf('this.dynamicRoutes.push(', start + 1));
}

/** The body of the view's stop handler. */
function stopHandler(): string {
  const start = VIEW.indexOf('async function stopRun(');
  expect(start, 'the view has a stop handler').toBeGreaterThan(-1);
  return VIEW.slice(start, VIEW.indexOf('\n\t}\n', start));
}

function i18nLine(key: string): string {
  const escaped = key.replace(/\./g, '\\.');
  const m = new RegExp(`'${escaped}':\\s*\\{([\\s\\S]*?)\\},`).exec(I18N);
  expect(m, `the i18n entry ${key} has to exist`).not.toBeNull();
  return m![1]!;
}

describe('the schedules view can stop a run', () => {
  it('the view calls the stop route with POST and the trigger id', () => {
    expect(stopHandler()).toMatch(/fetch\(`\$\{getApiBase\(\)\}\/tasks\/\$\{trigger\.id\}\/stop`, \{ method: 'POST' \}\)/);
  });

  it('the stop control is offered only on a row the list reports as stoppable', () => {
    // The button's `{#if}` is what has to read the flag — a flag read only by the badge
    // would leave the button on every row, and `running` would offer it on a backup.
    const button = VIEW.indexOf('onclick={() => stopRun(trigger)}');
    expect(button, 'the button exists').toBeGreaterThan(-1);
    const guard = VIEW.lastIndexOf('{#if', button);
    expect(VIEW.slice(guard, button)).toMatch(/^\{#if trigger\.stoppable === true\}/);
    // and the route sends the flag at all.
    expect(ROUTE).toMatch(/stoppable: visible && loop\?\.runningStoppable\(trigger\.id\) === true/);
  });

  it('a started run is shown at once: Run now reloads the list after its 202', () => {
    const start = VIEW.indexOf('async function runNow(');
    const body = VIEW.slice(start, VIEW.indexOf('\n\t}\n', start));
    expect(body).toMatch(/res\.status === 202\)\s*\{[^}]*addToast\(t\('triggers\.run_started'\)[^}]*await loadTriggers\(true\);/);
  });

  it('a Run now refused as already running also reloads, so the running row shows its stop', () => {
    const start = VIEW.indexOf('async function runNow(');
    const body = VIEW.slice(start, VIEW.indexOf('\n\t}\n', start));
    expect(body).toMatch(/res\.status === 409\)\s*\{[\s\S]*?'triggers\.run_already'\), 'info'\);\s*\/\/[^\n]*\n\s*await loadTriggers\(true\);/);
  });

  it('the refresh after a stop or a start is quiet — the list is not swapped for the loading line', () => {
    expect(stopHandler()).toContain('await loadTriggers(true);');
    expect(VIEW).toMatch(/async function loadTriggers\(quiet = false\) \{\s*if \(!quiet\) loading = true;/);
  });

  it('every 409 of the route carries one of the codes, and the view switches on each', () => {
    const route = stopRoute();
    const conflicts = [...route.matchAll(/errorResponse\(res, 409, (?:'[^']*'|`[^`]*`), '([a-z_]+)'\)/g)].map((m) => m[1]);
    // Every 409 in the route is one the pattern read: a 409 without a code would reach
    // the view's generic "could not stop" line.
    expect(conflicts.length, 'a 409 in the stop route has no code').toBe(route.split('errorResponse(res, 409,').length - 1);
    expect(new Set(conflicts)).toEqual(new Set(CODES));
    const handler = stopHandler();
    for (const code of CODES) {
      // The PAIR, not two substrings: a swap of two keys would leave both strings present.
      expect(handler, `the view maps ${code} to ${KEY_OF[code]}`).toContain(`code === '${code}' ? '${KEY_OF[code]}'`);
    }
  });

  it('the 202 and the 403 have their own lines, and the 403 is the one the route sends', () => {
    const handler = stopHandler();
    expect(handler).toMatch(/res\.status === 202\)\s*\{\s*addToast\(t\('triggers\.stop_requested'\)/);
    expect(handler).toMatch(/res\.status === 403\)\s*\{\s*addToast\(t\('triggers\.stop_forbidden'\)/);
    expect(stopRoute()).toContain("this._refuseUnlessOwns(_req, res, 'stop this task'");
  });

  it('each line exists in both languages', () => {
    for (const key of ['triggers.running', 'triggers.stop_run', 'triggers.stop_requested', 'triggers.stop_forbidden', 'triggers.stop_failed', ...Object.values(KEY_OF)]) {
      const line = i18nLine(key);
      expect(line, `${key} de`).toMatch(/\bde:\s*'[^']{6,}'/);
      expect(line, `${key} en`).toMatch(/\ben:\s*["'][^"']{6,}["']/);
    }
  });

  it('the 202 line does not claim the run has ended', () => {
    // A stop is requested, not completed; the route never answers `stopped: true`.
    const line = i18nLine('triggers.stop_requested');
    expect(line).toMatch(/angefordert/);
    expect(line).not.toMatch(/angehalten\.|gestoppt\.|wurde beendet|has stopped|was stopped/);
    // and it says the RUN may finish, not only the step it is in: between model calls a
    // stop reaches nothing, so the whole run can complete.
    expect(line).toMatch(/Der Lauf kann/);
    expect(line).toMatch(/The run may still finish/);
  });
});
