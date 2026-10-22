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

  // The chain from the copy to what the owner reads: one shared module renders through the copy,
  // and every page that shows such text renders through that module. A page with a matcher of its
  // own would mark a different set and still pass the byte comparison above.
  it('the shared renderer marks through the web UI copy (positive control)', () => {
    const shared = readFileSync(resolve(repoRoot, 'packages/web-ui/src/lib/visible-text.ts'), 'utf8');
    expect(shared).toMatch(/import \{ hiddenCharIndexes \} from '\.\/hidden-chars\.js';/);
    expect(shared).toMatch(/new Set\(hiddenCharIndexes\(text\)\)/);
  });

  it('the bulk pages and the approval card render through the shared module', () => {
    const bulk = readFileSync(resolve(repoRoot, 'packages/web-ui/src/lib/components/bulk-runs.ts'), 'utf8');
    expect(bulk).toMatch(/import \{ visibleText \} from '\.\.\/visible-text\.js';/);
    expect(bulk).toMatch(/export const bulkVisibleText: \(text: string\) => string = visibleText;/);
    const card = readFileSync(resolve(repoRoot, 'packages/web-ui/src/lib/components/ApprovalCard.svelte'), 'utf8');
    expect(card).toMatch(/import \{ visibleText \} from '\.\.\/visible-text\.js';/);
  });
});
