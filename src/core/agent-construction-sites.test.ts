import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every place that builds an Agent hands it a ToolContext.
 *
 * The egress policy lives on the ToolContext, and an Agent built without one makes an empty
 * context of its own, whose policy is unset — which the egress check treats as allow-all.
 * So every `new Agent(` in src/ must pass one. The set of sites is pinned: a new site fails
 * here until it is listed, and listing it means deciding where its context comes from.
 *
 * This reads the source, so it sees that a site passes the key, not that a value arrives:
 * a site that forwards an optional parameter passes it even when the caller left it out.
 * Whether the engine's context reaches each step runtime is pinned by behaviour, in
 * runtime-adapter.test.ts and runner.test.ts.
 */
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** The text from `open` to its matching close, counting only that bracket pair. */
function balanced(text: string, open: number): string {
  const o = text[open]!;
  const c = o === '{' ? '}' : ')';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${o} at ${open}`);
}

/** The config object a `new Agent(` site passes: an inline literal, or the literal a named const holds. */
function configOf(text: string, at: number): string {
  const args = balanced(text, text.indexOf('(', at));
  const inner = args.slice(1, -1).trim();
  if (inner.startsWith('{')) return inner;
  const decl = new RegExp(`const ${inner}\\b[^=]*=\\s*\\{`).exec(text);
  if (!decl) throw new Error(`no object literal found for ${inner}`);
  return balanced(text, decl.index + decl[0].length - 1);
}

function agentSites(): Array<{ site: string; config: string }> {
  const sites: Array<{ site: string; config: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let offset = 0;
    lines.forEach((line, i) => {
      const col = line.indexOf('new Agent(');
      const code = line.trimStart();
      if (col >= 0 && !code.startsWith('//') && !code.startsWith('*')) {
        sites.push({ site: `${relative(SRC, file)}:${i + 1}`, config: configOf(text, offset + col) });
      }
      offset += line.length + 1;
    });
  }
  return sites;
}

describe('Agent construction sites', () => {
  it('pins every place the engine builds an Agent', () => {
    // Line numbers are left out so an unrelated edit above a site does not fail this.
    const files = agentSites().map((s) => s.site.replace(/:\d+$/, '')).sort();
    expect(files, 'a new `new Agent(` site must hand in the engine ToolContext and be listed here').toEqual([
      'core/session.ts',
      'orchestrator/runtime-adapter.ts',
      'orchestrator/runtime-adapter.ts',
      'tools/builtin/spawn.ts',
    ]);
  });

  it('hands every Agent a ToolContext', () => {
    const missing = agentSites().filter((s) => !/^\s*toolContext\s*[:,]/m.test(s.config)).map((s) => s.site);
    expect(missing).toEqual([]);
  });
});
