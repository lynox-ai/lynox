import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A product target's stored title (`bulk_targets.target_title`) is for the owner's eyes: the
// preview's read writes it and the targets route shows it. A model never reads it. That holds
// while the readers that feed a model (the judge's `loadJudgeTarget`, the tool's status) pick
// their columns by name; so this counts every file that names the column, and refuses a
// `SELECT *` over bulk_targets, which would carry it along without naming it. A new mention has
// to be looked at and either removed or added below with why it is not on a model's way.
const COLUMN = /\btarget_title\b/g;
const SELECT_ALL = /SELECT\s+(?:\w+\.)?\*[^`'"]*\bFROM\s+bulk_targets\b/gi;

/** Every file that names the column today, with why that is not a way to a model. */
const EXPECTED: Record<string, { count: number; why: string }> = {
  'src/core/engine-db.ts': { count: 1, why: 'the migration that adds the column' },
  'src/core/bulk-ledger.ts': { count: 6, why: 'recordRead writes it from the store\'s read (and its doc names it); getPreview reads it for the owner\'s targets route' },
  'src/core/export-tables.ts': { count: 1, why: 'the customer\'s data export decrypts it' },
};

const ROOT = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('the stored target title', () => {
  it('the patterns find the shapes they are meant to find', () => {
    expect('SELECT seq, target_title FROM bulk_targets'.match(COLUMN)).toHaveLength(1);
    expect('target_titles'.match(COLUMN)).toBeNull();
    for (const q of ['SELECT * FROM bulk_targets WHERE run_id = ?', 'SELECT t.* FROM bulk_targets t', 'select *\n  from bulk_targets']) {
      expect(q.match(SELECT_ALL), q).toHaveLength(1);
    }
    for (const q of ['SELECT seq, before FROM bulk_targets', 'SELECT COUNT(*) AS n FROM bulk_targets', 'SELECT * FROM bulk_runs']) {
      expect(q.match(SELECT_ALL), q).toBeNull();
    }
  });

  it('is named only where it is written for the owner, shown to the owner, or exported', () => {
    const found: Record<string, number> = {};
    for (const file of sources(join(ROOT, 'src'))) {
      const n = readFileSync(file, 'utf-8').match(COLUMN)?.length ?? 0;
      if (n > 0) found[relative(ROOT, file).split('\\').join('/')] = n;
    }
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([f, { count }]) => [f, count]));
    expect(found, 'A file started or stopped naming target_title. If it hands the title to a model (a tool result, a status text, the judge), it must not; otherwise update EXPECTED with the reason.').toEqual(expected);
  });

  it('is never carried along by a SELECT * over bulk_targets', () => {
    const found: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      if ((readFileSync(file, 'utf-8').match(SELECT_ALL)?.length ?? 0) > 0) found.push(relative(ROOT, file).split('\\').join('/'));
    }
    expect(found, 'A SELECT * over bulk_targets would hand the stored title to whatever reads the row; name the columns.').toEqual([]);
  });
});
