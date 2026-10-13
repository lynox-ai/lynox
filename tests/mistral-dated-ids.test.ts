/**
 * No call site pins a Mistral `-latest` alias.
 *
 * The aliases carry much lower rate limits than the dated tags and roll to another model
 * without notice, so production code, the setup pickers and the online tests name a dated id
 * (`MISTRAL_MODEL_MAP` in `src/types/models.ts` holds the pinned ones). The registry itself is
 * the one place an alias may appear: it prices configurations that still name one, so their
 * spend is counted at the model that answers (`MISTRAL_SERVED_AS`).
 *
 * Scanned: non-test sources under `src/`, the web UI's `src/`, and `tests/online/` (those
 * tests call the real API). NOT scanned: `scripts/` (the set-bench config compares an alias
 * against its pinned tag on purpose) and unit tests, which pass alias strings through stubs and
 * reach no provider. Comments are dropped before matching — a sentence ABOUT an alias pins
 * nothing — and code after a closing block comment on the same line is still read. The comment
 * stripping is textual, not a parser: a ` //` or a `/* … *\/` inside a string literal counts as a
 * comment too, so an alias after it on that line is not seen. It matches a literal: an id
 * assembled at run time (`'mistral-small-' + 'latest'`) is not seen either.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const ALIAS = /\b(?:mistral|ministral|magistral|codestral|devstral|pixtral|voxtral)(?:-[a-z0-9.]+)*-latest\b/;
/** The registry prices legacy configurations that still name an alias. */
const REGISTRY = 'src/types/models.ts';

function walk(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, keep, out);
    else if (keep(relative(root, abs))) out.push(relative(root, abs));
  }
  return out;
}

const isSource = (rel: string): boolean => /\.(ts|svelte)$/.test(rel) && !/\.test\.ts$/.test(rel);
const files = [
  ...walk(join(root, 'src'), isSource),
  ...walk(join(root, 'packages', 'web-ui', 'src'), isSource),
  ...walk(join(root, 'tests', 'online'), (rel) => rel.endsWith('.ts')),
];

/** The code part of one line if it names an alias, else null. Comments are dropped first. */
function aliasCode(line: string): string | null {
  // Drop inline block comments and a trailing line comment, then a block-comment continuation.
  const code = line.replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/.*$/, '').trim();
  if (code.startsWith('*') || code.startsWith('/*')) return null;
  return ALIAS.test(code) ? code : null;
}

/** `file:line  text` for every code line in `rel` that names an alias. */
function aliasLines(rel: string): string[] {
  return readFileSync(join(root, rel), 'utf8').split('\n').flatMap((line, i) => {
    const code = aliasCode(line);
    return code === null ? [] : [`${rel}:${i + 1}  ${code}`];
  });
}

describe('Mistral ids are dated at every call site', () => {
  it('positive control: the scan reaches the files and sees the registry aliases', () => {
    expect(files.length, 'files scanned').toBeGreaterThan(100);
    expect(files).toContain('src/integrations/inbox/classifier/llm-mistral.ts');
    expect(files).toContain('packages/web-ui/src/lib/components/SetupBanner.svelte');
    expect(aliasLines(REGISTRY).length, 'the registry names aliases, so the pattern matches').toBeGreaterThan(0);
  });

  it('reads code, not comments: after a closed block comment yes, inside a comment no', () => {
    const alias = 'mistral-small-' + 'latest'; // assembled, so this file does not name one
    expect(aliasCode(`/* x */ const m = '${alias}';`), 'code after a closed block comment').not.toBeNull();
    expect(aliasCode(`const m = '${alias}'; // pinned`), 'code before a line comment').not.toBeNull();
    expect(aliasCode(`// the old default was ${alias}`), 'a line comment').toBeNull();
    expect(aliasCode(` * once ${alias}`), 'a block-comment continuation').toBeNull();
    expect(aliasCode(`/* ${alias} */`), 'a closed block comment alone').toBeNull();
    expect(aliasCode(`const v = '${'voxtral-mini-' + 'latest'}';`), 'the voice family too').not.toBeNull();
  });

  it('no call site outside the registry names a -latest alias', () => {
    const hits = files.filter((rel) => rel !== REGISTRY).flatMap(aliasLines);
    expect(hits, 'name a dated id (see MISTRAL_MODEL_MAP), not a -latest alias').toEqual([]);
  });
});
