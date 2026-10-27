import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as builtinTools from '../tools/builtin/index.js';
import type { ToolEntry } from '../types/index.js';

/**
 * A tool that hands work to a child agent must let `secret:NAME` references travel as written
 * (`ToolEntry.secretRefs`): resolved before its handler, the plaintext would go into the
 * child's task text, its prompt and its run history.
 *
 * Which tools do that is read from the source, not from a list: a file that defines a tool and
 * imports what builds a child agent (the `Agent` class, a `Session`, the workflow runner or the
 * step spawners) is one whose tools hand work on. A namespace or dynamic import of one of those
 * modules counts as such an import. A tool added there that does not declare it fails here,
 * without anyone having to remember this rule.
 */
const SRC = join(import.meta.dirname, '..');

/** Imports that build a child agent: the Agent class as a value, or the workflow runner. */
// The path may not run through `types/`: `types/agent.js` holds the agent's types, not the class.
const CHILD_BUILDER = /import\s*\{([^}]*)\}\s*from\s*'((?:(?!types\/)[^'])*\/)(agent|runner|runtime-adapter|session)\.js'/g;
const BUILDER_NAMES: Record<string, readonly string[]> = {
  agent: ['Agent'],
  runner: ['runManifest', 'retryManifest'],
  'runtime-adapter': ['spawnInline', 'spawnViaAgent', 'spawnPipeline'],
  session: ['Session'],
};
/** A namespace or dynamic import of a builder module reaches every builder in it. */
const WHOLE_MODULE = /(import\s*\*\s*as\s+\w+\s*from|import\()\s*'(?:(?!types\/)[^'])*\/(agent|runner|runtime-adapter|session)\.js'/;

/**
 * Files that import a builder and define a tool shape, but whose tools are not built-in entries:
 * each with its reason.
 */
const NOT_BUILTIN_TOOLS: Record<string, string> = {
  // Converts the tools of an agent definition module for the step that runs them; those tools
  // run INSIDE the child, they do not build one.
  'orchestrator/runtime-adapter.ts': 'converts definition-module tools that run inside a step',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

function importsChildBuilder(text: string): boolean {
  if (WHOLE_MODULE.test(text)) return true;
  for (const m of text.matchAll(CHILD_BUILDER)) {
    const names = m[1]!.split(',').map((n) => n.trim()).filter((n) => n !== '' && !n.startsWith('type '));
    if (names.some((n) => BUILDER_NAMES[m[3]!]!.includes(n.split(/\s+as\s+/)[0]!))) return true;
  }
  return false;
}

/** Tool names a file defines as built-in entries: `definition: { name: '…'`. */
function toolNamesIn(text: string): string[] {
  return [...text.matchAll(/definition:\s*\{\s*name:\s*'([a-z_]+)'/g)].map((m) => m[1]!);
}

const builtinByName = new Map<string, ToolEntry>(
  Object.values(builtinTools)
    .filter((v): v is ToolEntry => typeof v === 'object' && v !== null && 'definition' in v && 'handler' in v)
    .map((t) => [t.definition.name, t]),
);

describe('a tool that hands work to a child agent lets secret references travel as written', () => {
  const delegating = sourceFiles(SRC)
    .map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf-8') }))
    .filter(({ file, text }) => /input_schema/.test(text) && importsChildBuilder(text) && NOT_BUILTIN_TOOLS[file] === undefined);

  it('finds the tools that do so today (the scan reads what it claims to read)', () => {
    const names = delegating.flatMap(({ text }) => toolNamesIn(text)).sort();
    expect(names).toEqual(['run_workflow', 'spawn_agent']);
  });

  it.each(delegating.map(({ file, text }) => [file, toolNamesIn(text)] as const))('%s declares it for every tool it defines', (file, names) => {
    expect(names.length, `${file} imports a child builder but defines no tool this scan can read`).toBeGreaterThan(0);
    for (const name of names) {
      const entry = builtinByName.get(name);
      expect(entry, `${name} (${file}) is not exported from tools/builtin/index.ts`).toBeDefined();
      expect(entry!.secretRefs, `${name} hands work to a child agent and must declare secretRefs: 'verbatim'`).toBe('verbatim');
    }
  });

  it('reads a type-only import as no builder (control)', () => {
    expect(importsChildBuilder("import type { Agent } from '../../core/agent.js';")).toBe(false);
    expect(importsChildBuilder("import { type Agent } from '../../core/agent.js';")).toBe(false);
    expect(importsChildBuilder("import { Agent, RunAbortedError } from '../../core/agent.js';")).toBe(true);
    expect(importsChildBuilder("import { runManifest } from '../../orchestrator/runner.js';")).toBe(true);
    expect(importsChildBuilder("import { spawnInline } from '../../orchestrator/runtime-adapter.js';")).toBe(true);
    expect(importsChildBuilder("import { INLINE_NAMED_ONLY_TOOLS } from '../../orchestrator/runtime-adapter.js';")).toBe(false);
    expect(importsChildBuilder("import { Session } from '../../core/session.js';")).toBe(true);
    expect(importsChildBuilder("import * as adapter from '../../orchestrator/runtime-adapter.js';")).toBe(true);
    expect(importsChildBuilder("const { Agent } = await import('../../core/agent.js');")).toBe(true);
    expect(importsChildBuilder("type P = import('../../types/agent.js').ProviderConfigSnapshot;")).toBe(false);
  });
});
