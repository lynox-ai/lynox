/**
 * No harness mock may take a tool name the engine injects on its own, and the
 * name that keeps the engine's search tool OUT must stay the one the engine
 * actually looks for.
 *
 * The defect this exists for, measured 2026-09-23 against the real API: the
 * `research-multihop` scenario named its mock search tool `web_search`. On an
 * Anthropic-direct request the engine appends Anthropic's server-side search tool,
 * which is also named `web_search`, unless a tool called `web_research` is
 * registered. Two tools of one name is a 400 — "tools: Tool names must be unique" —
 * so the scenario died at iteration 0 on every Claude candidate. Because an error
 * disqualifies a candidate from the tier grid, and this scenario gates balanced and
 * deep, it marked those models unfit for both: a FAIL with no cause, the mirror of
 * the FIT-with-no-measurement defects this harness shipped with.
 *
 * What these assertions do and do not prove, because the difference decides what a
 * green run means: they read SOURCE and catch literals, which is the form the defect
 * took. They do not build a request, so a name assembled at runtime is invisible to
 * them, and the extraction only sees a tool definition written on one line in the
 * usual order. The third assertion is the one that would have caught the original
 * defect from either side.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * Tool names the engine puts into a request itself, READ OUT OF the engine rather
 * than copied here: a server-side tool literal pairs a `type` with a `name`, and
 * both of today's — the Anthropic search tool and the lazy path's tool-search tool —
 * are written that way in `src/core/agent.ts`. Deriving them means a third one
 * starts being checked the day it is added, and it means a hand-kept list cannot
 * quietly lose an entry: dropping one here was measured to change nothing, because
 * no harness file happens to use that name today.
 */
function engineInjectedNames(): string[] {
  const m = [...read('src/core/agent.ts').matchAll(/type: '[a-z0-9_]+'(?: as const)?,\s*name: '([a-z0-9_]+)'/g)];
  return [...new Set(m.map((x) => x[1]!))];
}

const HARNESS_DIR = 'scripts/model-fitness';
const FILES = [`${HARNESS_DIR}/scenarios.ts`, `${HARNESS_DIR}/capabilities.ts`];

/** Every `name: '…'` that sits inside a tool definition literal in a harness file. */
function declaredToolNames(rel: string): string[] {
  return [...read(rel).matchAll(/\{\s*name:\s*'([a-z0-9_]+)'\s*,\s*description:/g)].map((m) => m[1]!);
}

describe('harness tool names', () => {
  it('finds the tool names at all', () => {
    // The positive control. An extraction that silently matches nothing reports
    // every file clean — a guard that has stopped guarding, not a clean codebase.
    const all = FILES.flatMap(declaredToolNames);
    expect(all.length, 'no tool definitions extracted — the pattern has drifted').toBeGreaterThan(10);
    expect(all).toContain('web_fetch');
  });

  it('looks at every harness file that declares tools', () => {
    // FILES is hand-written, so a new harness file could carry a colliding name and
    // never be read. Anything in the directory that defines a tool must be listed.
    const dir = fileURLToPath(new URL(`../${HARNESS_DIR}/`, import.meta.url));
    const declaring = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && read(`${HARNESS_DIR}/${f}`).includes('input_schema:'))
      .map((f) => `${HARNESS_DIR}/${f}`);
    expect(declaring.sort()).toEqual([...FILES].sort());
  });

  it('reads the engine-injected names out of the engine', () => {
    // Positive control for the derivation: an expression that matched nothing would
    // make the next assertion vacuously true for every name.
    const injected = engineInjectedNames();
    expect(injected, 'no server-side tool literals found in agent.ts').toContain('web_search');
    expect(injected.length).toBeGreaterThan(1);
  });

  it('takes no name the engine injects itself', () => {
    const injected = engineInjectedNames();
    for (const f of FILES) {
      const clash = declaredToolNames(f).filter((n) => injected.includes(n));
      expect(clash, `${f} declares a tool the engine also sends`).toEqual([]);
    }
  });

  it('keeps the suppressing mock named exactly what the engine looks for', () => {
    // The coupling nothing else pins: the engine drops its own search tool only for
    // one literal name, and the research scenario depends on that dropping. Rename
    // either side alone and the 400 returns with every other assertion green.
    const guard = /t\.definition\.name === '([a-z0-9_]+)'/.exec(read('src/core/agent.ts'));
    expect(guard, 'the hasWebResearch guard literal was not found in agent.ts').not.toBeNull();
    expect(declaredToolNames(`${HARNESS_DIR}/scenarios.ts`)).toContain(guard![1]!);
  });
});
