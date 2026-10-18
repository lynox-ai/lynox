/**
 * The engine refuses a judge rule that carries a hidden character, and the bulk pages of the web
 * UI mark the same characters in what the owner reads. Both read one file, which the web UI keeps
 * a copy of because it is a package of its own. The rules are about sequences (a joiner counts
 * as text only between two emoji parts), so a comparison per code point would not see a
 * difference; the copy must be the same file, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = 'src/core/hidden-chars.ts';
const WEB_UI = 'packages/web-ui/src/lib/hidden-chars.ts';

describe('hidden characters: the web UI marks exactly what the engine refuses', () => {
  it(`${WEB_UI} === ${ENGINE}, byte for byte`, () => {
    const engine = readFileSync(resolve(repoRoot, ENGINE));
    const webUi = readFileSync(resolve(repoRoot, WEB_UI));
    expect(engine.length).toBeGreaterThan(0);
    expect(webUi.equals(engine)).toBe(true);
  });

  it('the bulk pages mark through the web UI copy (positive control)', () => {
    const helpers = readFileSync(resolve(repoRoot, 'packages/web-ui/src/lib/components/bulk-runs.ts'), 'utf8');
    expect(helpers).toMatch(/import \{ hiddenCharIndexes \} from '\.\.\/hidden-chars\.js';/);
    expect(helpers).toMatch(/new Set\(hiddenCharIndexes\(text\)\)/);
  });
});
