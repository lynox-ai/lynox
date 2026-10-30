import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetShellIsolationForTest, setShellIsolationForTest, WORKSPACE_LABEL } from './shell-isolation.js';
import { anchorFromFd, closeAnchor, type WorkspaceAnchor } from './workspace-fd.js';
import { _resetWorkspaceAccess } from './workspace-access.js';
import { _resetCache, clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { AreaRefusal, areaTarget, readAreaText } from './file-area-anchor.js';

/**
 * In sidecar mode a pool uid can write the workspace while the engine reads it. Here a second
 * process does what such a uid could do (here under the same uid; refusing a link does not depend
 * on who made it): it keeps turning a path into a link to a file outside the workspace and back,
 * as fast as it can, while this process reads that path through `readAreaText`. That is the read
 * route's code, and its open (`areaTarget` + `openAreaFile`) is the download route's. The read must
 * never return the outside file. That both other outcomes occur (the inside content, and a
 * refusal of the link) shows the two processes did meet; without them the test proves nothing.
 */

const INSIDE = 'inside content';
const SECRET = 'engine-only content';
const READ_MS = 1500;

// The swapper. `leaf`: the file itself alternates with a link (rename over it, so the name is
// never missing). `dir`: a directory on the way alternates with a link to an outside directory.
const SWAPPER = `
const fs = require('fs'); const p = require('path');
const [mode, ctx, outside, ms] = process.argv.slice(1);
const end = Date.now() + Number(ms);
let swaps = 0;
if (mode === 'leaf') {
  const f = p.join(ctx, 'f.txt'), l = p.join(ctx, '.l'), t = p.join(ctx, '.t');
  while (Date.now() < end) {
    fs.symlinkSync(p.join(outside, 'f.txt'), l); fs.renameSync(l, f);
    if (swaps === 0) process.stdout.write('go\\n');
    fs.writeFileSync(t, ${JSON.stringify(INSIDE)}); fs.renameSync(t, f);
    swaps++;
  }
} else {
  const d = p.join(ctx, 'd'), real = p.join(ctx, 'd.real');
  while (Date.now() < end) {
    fs.renameSync(real, d);
    if (swaps === 0) process.stdout.write('go\\n');
    fs.renameSync(d, real);
    fs.symlinkSync(outside, d); fs.unlinkSync(d);
    swaps++;
  }
}
process.stdout.write('swaps ' + swaps + '\\n');
`;

interface Tally { inside: number; secret: number; link: number; missing: number; other: string[] }

async function race(mode: 'leaf' | 'dir', ctxDir: string, outside: string, readPath: string): Promise<{ tally: Tally; swaps: number }> {
  const child = spawn(process.execPath, ['-e', SWAPPER, mode, ctxDir, outside, String(READ_MS + 1000)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  // 'close', not 'exit': only then has all of the child's output been read.
  const closed = new Promise<number | null>((res) => child.on('close', res));
  await new Promise<void>((res, rej) => {
    child.stdout.on('data', (s: string) => { out += s; if (out.includes('go\n')) res(); });
    void closed.then((code) => rej(new Error(`swapper exited early (${code})`)));
  });
  const tally: Tally = { inside: 0, secret: 0, link: 0, missing: 0, other: [] };
  const end = Date.now() + READ_MS;
  while (Date.now() < end) {
    try {
      const text = readAreaText(areaTarget(readPath)!, 1024, 'too large');
      if (text === INSIDE) tally.inside++;
      else if (text === SECRET) tally.secret++;
      else tally.other.push(`content ${JSON.stringify(text)}`);
    } catch (err) {
      if (err instanceof AreaRefusal && err.status === 403) tally.link++;
      else if (err instanceof AreaRefusal && err.status === 404) tally.missing++;
      else tally.other.push(String(err));
    }
  }
  expect(await closed).toBe(0);
  const swaps = Number(/swaps (\d+)/.exec(out)?.[1] ?? '0');
  return { tally, swaps };
}

describe('a read while another process swaps the path between a file and a link (sidecar mode)', () => {
  let ws: string;
  let tree: string;
  let outside: string;
  let anchor: WorkspaceAnchor;
  let prevData: string | undefined;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-read-race-')));
    tree = join(ws, 'tree');
    outside = join(ws, 'engine-only');
    mkdirSync(join(tree, 'ctx1'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'f.txt'), SECRET);
    mkdirSync(join(ws, 'data'));
    prevData = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = join(ws, 'data');
    closeWorkspaceBase();
    anchor = anchorFromFd(openSync(tree, constants.O_RDONLY | constants.O_DIRECTORY), WORKSPACE_LABEL);
    setShellIsolationForTest({ kind: 'sidecar', socket: join(ws, 'exec.sock'), root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } });
    _resetCache();
    setTenantWorkspace(join(WORKSPACE_LABEL, 'ctx1'));
  });

  afterEach(() => {
    closeWorkspaceBase();
    clearTenantWorkspace();
    _resetWorkspaceAccess();
    _resetCache();
    resetShellIsolationForTest();
    closeAnchor(anchor);
    if (prevData === undefined) delete process.env['LYNOX_DATA_DIR']; else process.env['LYNOX_DATA_DIR'] = prevData;
    rmSync(ws, { recursive: true, force: true });
  });

  it('never returns the outside file when the file itself is swapped', async () => {
    writeFileSync(join(tree, 'ctx1', 'f.txt'), INSIDE);
    const { tally, swaps } = await race('leaf', join(tree, 'ctx1'), outside, join(WORKSPACE_LABEL, 'ctx1', 'f.txt'));
    expect(tally.other).toEqual([]);
    expect(tally.secret).toBe(0);
    // The two processes met: the reader saw both states.
    expect(swaps).toBeGreaterThan(100);
    expect(tally.inside).toBeGreaterThan(0);
    expect(tally.link).toBeGreaterThan(0);
  }, 20_000);

  it('never returns the outside file when a directory on the way is swapped', async () => {
    mkdirSync(join(tree, 'ctx1', 'd.real'));
    writeFileSync(join(tree, 'ctx1', 'd.real', 'f.txt'), INSIDE);
    const { tally, swaps } = await race('dir', join(tree, 'ctx1'), outside, join(WORKSPACE_LABEL, 'ctx1', 'd', 'f.txt'));
    expect(tally.other).toEqual([]);
    expect(tally.secret).toBe(0);
    expect(swaps).toBeGreaterThan(100);
    expect(tally.inside).toBeGreaterThan(0);
    expect(tally.link).toBeGreaterThan(0);
  }, 20_000);
});
