/**
 * scripts/corpus-structure-guard.mjs — an added or changed file whose content has the shape of an
 * eval corpus (an object carrying a `turns` or `gold` array) is refused, whatever it is called.
 *
 * No corpus lives in this file: every corpus-shaped value is assembled at run time from invented
 * words, and the key names themselves are joined from pieces, so this file is not an example of
 * what the guard refuses.
 *
 * Three callers are pinned at the end: the pre-commit command, the pre-push script and the step
 * in the required public-repo-guard CI job. The behaviour of the pre-push script across pushed
 * ranges is covered with the other range hooks in tests/pre-push-scripts.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { classify, maxBytes, stripJsonc, blobId, ALLOWED } from '../scripts/corpus-structure-guard.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts/corpus-structure-guard.mjs');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as NodeJS.ProcessEnv;
const T = 30_000;

const TURNS = ['tu', 'rns'].join('');
const GOLD = ['go', 'ld'].join('');
/** A corpus-shaped value: one thread with one turn and one fact, all invented. */
const corpus = () => ({ version: 1, threads: [{ id: 't1', [TURNS]: [{ text: 'alpha' }], [GOLD]: [{ id: 'f1', fact: 'beta' }] }] });
const buf = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'corpus-guard-')); });
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function repo() {
  const dir = mkdtempSync(join(tmp, 'r-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  const put = (p: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  };
  const guard = (args: string[], env: NodeJS.ProcessEnv = GIT_ENV) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, git, put, guard, head: () => git('rev-parse', 'HEAD').trim() };
}

describe('classify — what an added file holds decides, not its name', () => {
  it('refuses a corpus with both arrays, and one with only a deeply nested gold array', () => {
    expect(classify('corpus.json', buf(corpus()))).toMatchObject({ refuse: true, reason: 'corpus' });
    const deep = { a: { b: [{ c: { d: { [GOLD]: [] } } }] } };
    expect(classify('data/export.json', buf(deep))).toMatchObject({ refuse: true, reason: 'corpus' });
    const onlyTurns = { [TURNS]: [{ text: 'x' }] };
    expect(classify('x.json', buf(onlyTurns))).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('matches the keys without regard to case, and only when the value is an array', () => {
    expect(classify('x.json', buf({ [TURNS.toUpperCase()]: [] }))).toMatchObject({ refuse: true, reason: 'corpus' });
    expect(classify('x.json', buf({ [TURNS]: { count: 3 }, [GOLD]: 'none' }))).toEqual({ refuse: false, note: 'JSON' });
  });

  it('reads the content under any name: a corpus called data.txt is refused', () => {
    expect(classify('data.txt', buf(corpus()))).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('reads one JSON value per line, the .jsonl form', () => {
    const lines = [JSON.stringify({ id: 'a', [TURNS]: [] }), JSON.stringify({ id: 'b' })].join('\n');
    expect(classify('threads.jsonl', buf(lines))).toMatchObject({ refuse: true, reason: 'corpus' });
    expect(classify('notes.log', buf(lines))).toMatchObject({ refuse: true, reason: 'corpus' });
    const plain = [JSON.stringify({ id: 'a' }), JSON.stringify({ id: 'b' })].join('\n');
    expect(classify('rows.jsonl', buf(plain))).toEqual({ refuse: false, note: 'JSON' });
  });

  it('reads JSON with comments and trailing commas, and passes such a file without the shape', () => {
    const jsonc = `{\n  // a note\n  "threads": [ { "${TURNS}": [], }, ],\n  /* more */\n}\n`;
    expect(classify('corpus.jsonc', buf(jsonc))).toMatchObject({ refuse: true, reason: 'corpus' });
    const tsconfig = '{\n  // options\n  "compilerOptions": { "strict": true, },\n  "include": ["src/**/*"],\n}\n';
    expect(classify('tsconfig.extra.json', buf(tsconfig))).toEqual({ refuse: false, note: 'JSON' });
  });

  it('parses a file named as JSON that starts with a comment, and passes it without the shape', () => {
    expect(classify('tsconfig.json', buf('// options\n{ "compilerOptions": {} }\n'))).toEqual({ refuse: false, note: 'JSON' });
    expect(classify('x.json', buf(`/* c */ { "${TURNS}": [] }`))).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('passes an empty file, and .json5 that JSON.parse cannot read', () => {
    expect(classify('empty.json', buf('  \n'))).toEqual({ refuse: false, note: 'empty' });
    expect(classify('renovate.json5', buf('{ extends: [\'base\'] }'))).toEqual({ refuse: false, note: 'not JSON' });
  });

  it('finds the shape behind a very large array without overflowing the stack', () => {
    const big = [...Array(200_000).fill(0), { [TURNS]: [] }];
    expect(classify('big.json', buf(big))).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('keeps a // or /* inside a string when it strips comments', () => {
    const text = '{ "url": "http://a/*b*/c", "x": 1 }';
    expect(JSON.parse(stripJsonc(text))).toEqual(JSON.parse(text));
  });

  it('decodes UTF-16 in both byte orders and drops a UTF-8 byte-order mark', () => {
    const json = JSON.stringify(corpus());
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
    const be = Buffer.from(le);
    be.swap16();
    expect(classify('a.json', le)).toMatchObject({ refuse: true, reason: 'corpus' });
    expect(classify('a.json', be)).toMatchObject({ refuse: true, reason: 'corpus' });
    expect(classify('a.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf(json)]))).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('passes a listed synthetic corpus only with its pinned content, and only at its path', () => {
    const [[listed, id]] = [...ALLOWED];
    const reviewed = readFileSync(join(REPO, listed!));
    expect(blobId(reviewed), 'the pin is the tracked file\'s blob id').toBe(id);
    expect(classify(listed!, reviewed)).toEqual({ refuse: false, note: 'allowed corpus' });
    expect(classify(listed!, buf(corpus()))).toMatchObject({ refuse: true, reason: 'corpus' });
    expect(classify(`copy/${listed!}`, reviewed)).toMatchObject({ refuse: true, reason: 'corpus' });
  });

  it('blobId is the id git gives the same content', () => {
    const d = mkdtempSync(join(tmp, 'blob-'));
    writeFileSync(join(d, 'f'), 'some content\n');
    expect(blobId(Buffer.from('some content\n'))).toBe(execFileSync('git', ['hash-object', join(d, 'f')], { encoding: 'utf8' }).trim());
  });

  it('refuses a file named as JSON that cannot be read; passes a non-JSON name that is not JSON', () => {
    expect(classify('broken.json', buf('{ "a": '))).toMatchObject({ refuse: true, reason: 'unreadable' });
    expect(classify('broken.json.bak', buf('{ "a": '))).toMatchObject({ refuse: true, reason: 'unreadable' });
    expect(classify('notes.ndjson', buf('plain words'))).toMatchObject({ refuse: true, reason: 'unreadable' });
    expect(classify('x.json', Buffer.from([0x7b, 0x00, 0x7d]))).toMatchObject({ refuse: true, reason: 'unreadable' });
    expect(classify('notes.md', buf('[link] text { not json'))).toEqual({ refuse: false, note: 'not JSON' });
    expect(classify('image.png', Buffer.from([0x89, 0x50, 0x00, 0x7b]))).toEqual({ refuse: false, note: 'not text' });
    expect(classify('readme.txt', buf('hello'))).toEqual({ refuse: false, note: 'not JSON' });
  });

  it('lets the environment lower the size limit, never raise it', () => {
    const def = maxBytes({});
    expect(def).toBe(100 * 1024 * 1024);
    expect(maxBytes({ CORPUS_GUARD_MAX_BYTES: '10' })).toBe(10);
    expect(maxBytes({ CORPUS_GUARD_MAX_BYTES: String(def * 2) })).toBe(def);
    expect(maxBytes({ CORPUS_GUARD_MAX_BYTES: 'many' })).toBe(def);
  });

  it('every file tracked today passes, and the one corpus-shaped file among them is the listed one', () => {
    // The blobs, as the guard reads them — not the working tree, and not through a symlink.
    const entries = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: REPO, encoding: 'utf8' })
      .split('\0').filter(Boolean)
      .map((l) => { const [meta, path] = l.split('\t'); const [mode, oid] = meta!.split(' '); return { mode: mode!, oid: oid!, path: path! }; })
      .filter((e) => e.mode === '100644' || e.mode === '100755');
    // One `cat-file --batch` for all of them: `<oid> blob <size>\n<content>\n` per entry.
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: REPO, input: entries.map((e) => e.oid).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024,
    });
    const refused: string[] = [];
    let listedSeen = 0;
    let at = 0;
    for (const e of entries) {
      const nl = out.indexOf(0x0a, at);
      const [oid, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
      expect([oid, type], e.path).toEqual([e.oid, 'blob']);
      const content = out.subarray(nl + 1, nl + 1 + Number(size));
      at = nl + 1 + Number(size) + 1;
      const v = classify(e.path, content);
      if (v.refuse) refused.push(`${e.path}: ${v.reason}`);
      else if (v.note === 'allowed corpus') listedSeen++;
    }
    expect(at, 'the whole batch output was consumed').toBe(out.length);
    expect(entries.length).toBeGreaterThan(1000);
    expect(refused).toEqual([]);
    // The positive control for the walk: the listed corpus IS found as a corpus.
    expect(listedSeen).toBe(ALLOWED.size);
  }, T);
});

describe('--staged — the pre-commit form reads the index', () => {
  it('refuses a staged corpus and names the path and what to do', () => {
    const r = repo();
    r.put('corpus.json', JSON.stringify(corpus()));
    r.git('add', 'corpus.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/corpus\.json \(the staged commit\) carries an array named `turns` or `gold`/);
    expect(g.err).toMatch(/list its path and blob id .* in ALLOWED/);
  }, T);

  it('control: a staged ordinary JSON file passes', () => {
    const r = repo();
    r.put('config/settings.json', JSON.stringify({ name: 'x', items: [1, 2] }));
    r.git('add', 'config/settings.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(0);
    expect(g.out).toMatch(/clean — 1 added or changed file\(s\) read/);
  }, T);

  it('reads what is STAGED, not the working tree', () => {
    const r = repo();
    r.put('corpus.json', JSON.stringify(corpus()));
    r.git('add', 'corpus.json');
    r.put('corpus.json', '{}');
    expect(r.guard(['--staged']).status).toBe(1);
  }, T);

  it('a CHANGED tracked file is read: ordinary JSON overwritten with a corpus is refused', () => {
    const r = repo();
    r.put('data.json', '{"a":1}');
    r.git('add', 'data.json');
    r.git('commit', '-q', '-m', 'data');
    r.put('data.json', JSON.stringify(corpus()));
    r.git('add', 'data.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/data\.json \(the staged commit\)/);
  }, T);

  it('new content at the listed path is read again and refused', () => {
    const r = repo();
    const [[listed]] = [...ALLOWED];
    r.put(listed!, readFileSync(join(REPO, listed!)));
    r.git('add', listed!);
    r.git('commit', '-q', '-m', 'listed fixture');
    expect(r.guard(['--staged']).status).toBe(0);
    r.put(listed!, JSON.stringify(corpus()));
    r.git('add', listed!);
    expect(r.guard(['--staged']).status).toBe(1);
  }, T);

  it('a type change is read: a symlink replaced by a corpus file is refused', () => {
    const r = repo();
    symlinkSync('README.md', join(r.dir, 'link.json'));
    r.git('add', 'link.json');
    r.git('commit', '-q', '-m', 'link');
    rmSync(join(r.dir, 'link.json'));
    r.put('link.json', JSON.stringify(corpus()));
    r.git('add', 'link.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/link\.json/);
  }, T);

  it('a rename is read as an addition: a listed corpus moved elsewhere is refused', () => {
    const r = repo();
    const [[listed]] = [...ALLOWED];
    r.put(listed!, readFileSync(join(REPO, listed!)));
    r.git('add', listed!);
    r.git('commit', '-q', '-m', 'listed fixture');
    r.git('mv', listed!, 'moved.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/moved\.json/);
  }, T);

  it('a symlink is not read and is counted as such', () => {
    const r = repo();
    const outside = join(tmp, `outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(corpus()));
    symlinkSync(outside, join(r.dir, 'linked.json'));
    r.git('add', 'linked.json');
    const g = r.guard(['--staged']);
    expect(g.status, g.err).toBe(0);
    expect(g.out).toMatch(/not read: 1 symlink\(s\)/);
  }, T);

  it('a file over the lowered size limit is refused, not skipped', () => {
    const r = repo();
    r.put('rows.json', JSON.stringify({ rows: 'x'.repeat(100) }));
    r.git('add', 'rows.json');
    const g = r.guard(['--staged'], { ...GIT_ENV, CORPUS_GUARD_MAX_BYTES: '50' });
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/rows\.json .*larger than 100 MiB/);
  }, T);

  it('outside a work tree it cannot read the index and exits 2, not 0', () => {
    const d = mkdtempSync(join(tmp, 'nogit-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--staged'], { cwd: d, env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: tmp }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/could not read what this change adds/);
  }, T);
});

describe('<base> <head> — the push and CI form reads every commit', () => {
  it('a corpus one commit adds and a later one deletes is still refused, at the commit that added it', () => {
    const r = repo();
    const base = r.head();
    r.put('corpus.json', JSON.stringify(corpus()));
    r.git('add', 'corpus.json');
    r.git('commit', '-q', '-m', 'add');
    const added = r.head().slice(0, 10);
    r.git('rm', '-q', 'corpus.json');
    r.git('commit', '-q', '-m', 'remove');
    const g = r.guard([base, r.head()]);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toContain(`corpus.json (commit ${added})`);
  }, T);

  it('--no-paths names the commit and the position, never the path', () => {
    const r = repo();
    const base = r.head();
    r.put('private-name.json', JSON.stringify(corpus()));
    r.git('add', 'private-name.json');
    r.git('commit', '-q', '-m', 'add');
    const g = r.guard([base, r.head(), '--no-paths']);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/file 1 in commit [0-9a-f]{10}/);
    expect(g.err).not.toContain('private-name');
  }, T);

  it('control: a range that adds ordinary files passes', () => {
    const r = repo();
    const base = r.head();
    r.put('a.json', '{"a":1}');
    r.put('b.md', '# b\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'add');
    const g = r.guard([base, r.head()]);
    expect(g.status, g.err).toBe(0);
    expect(g.out).toMatch(/clean — 2 added or changed file\(s\) read across 1 commit\(s\)/);
  }, T);

  it('a commit that CHANGES a tracked file into a corpus is refused in the range form too', () => {
    const r = repo();
    r.put('data.json', '{"a":1}');
    r.git('add', 'data.json');
    r.git('commit', '-q', '-m', 'data');
    const base = r.head();
    r.put('data.json', JSON.stringify(corpus()));
    r.git('commit', '-q', '-am', 'change');
    const g = r.guard([base, r.head()]);
    expect(g.status, g.err).toBe(1);
    expect(g.err).toMatch(/data\.json \(commit [0-9a-f]{10}\)/);
  }, T);

  it('an empty range exits 2, unless --allow-empty says a push may add nothing', () => {
    const r = repo();
    expect(r.guard([r.head(), r.head()]).status).toBe(2);
    expect(r.guard([r.head(), r.head(), '--allow-empty']).status).toBe(0);
  }, T);

  it('a ref that does not resolve exits 2, and so does half a range', () => {
    const r = repo();
    expect(r.guard(['no-such-ref', r.head()]).status).toBe(2);
    const half = r.guard([r.head()]);
    expect(half.status).toBe(2);
    expect(half.err).toMatch(/usage: corpus-structure-guard\.mjs/);
  }, T);
});

describe('the three callers', () => {
  const lefthook = parseYaml(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as {
    'pre-commit': { commands: Record<string, { run: string }> };
    'pre-push': { scripts: Record<string, unknown> };
  };

  it('pre-commit runs the staged form', () => {
    expect(lefthook['pre-commit'].commands['corpus-structure-guard']?.run).toBe('node scripts/corpus-structure-guard.mjs --staged');
  });

  it('pre-push runs the range form over each pushed range, also during a merge or rebase', () => {
    const entry = lefthook['pre-push'].scripts['corpus-structure-guard-commits.sh'] as { skip?: unknown } | undefined;
    expect(entry).toBeDefined();
    // A push made while a rebase is paused publishes like any other; the range comes from the
    // pushed refs, so there is nothing for a skip to protect.
    expect(entry!.skip).toBeUndefined();
    const hook = readFileSync(join(REPO, '.lefthook/pre-push/corpus-structure-guard-commits.sh'), 'utf8');
    const code = hook.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code).toMatch(/node scripts\/corpus-structure-guard\.mjs "\$base" "\$tip" --allow-empty \|\| exit \$\?/);
  });

  it('CI runs it inside the public-repo-guard job, from the base commit, without paths', () => {
    const wf = parseYaml(readFileSync(join(REPO, '.github/workflows/public-repo-guard.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    const steps = wf.jobs['public-repo-guard']?.steps ?? [];
    const mine = steps.filter((s) => (s.run ?? '').includes('corpus-structure-guard.mjs'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.run).toMatch(/git show "\$source:scripts\/corpus-structure-guard\.mjs" > "\$guard"/);
    expect(mine[0]!.run).toMatch(/node "\$guard" "\$base" "\$head" --no-paths/);
  });
});
