import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistChatUploadInArea } from './file-area-anchor.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';

/** The chat upload with isolation goes through the workspace's open directory. */

let ws: string;
let outside: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-upload-ws-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-upload-out-')));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('persistChatUploadInArea', () => {
  it('stores the upload under uploads/, private as before', () => {
    const stored = persistChatUploadInArea('Buchungen 2026.csv', 'id,amount\n1,42\n');
    expect(stored).not.toBeNull();
    expect(stored!.rel).toMatch(/^uploads\/[0-9TZ-]+-[0-9a-f]{8}-Buchungen_2026\.csv$/);
    expect(stored!.abs).toBe(join(ws, stored!.rel));
    expect(readFileSync(stored!.abs, 'utf8')).toBe('id,amount\n1,42\n');
    expect(statSync(stored!.abs).mode & 0o777).toBe(0o600);
    expect(statSync(join(ws, 'uploads')).mode & 0o777).toBe(0o700);
  });

  it('does not write through a link at uploads/, and answers null so the caller inlines the upload', () => {
    symlinkSync(outside, join(ws, 'uploads'));
    expect(persistChatUploadInArea('a.txt', 'text')).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(ws, 'uploads')).isSymbolicLink()).toBe(true);
  });
});
