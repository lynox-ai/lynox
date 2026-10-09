import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Which `lynox-backups` folder the uploader writes into and lists from, against an in-memory
 * Drive. Under the full `drive` scope a listing by name also returns folders other accounts
 * shared with the user. The fake returns every folder regardless of the granted scope, the
 * strict case, and in insertion order, so a folder inserted first is the first a listing sees.
 *
 * It answers with the fields a request names and no others, and honours `'me' in owners` only
 * when the query carries it: an implementation that forgot to request `isAppAuthorized`, or to
 * put the owner term in the query, would otherwise pass.
 * The transport is mocked at `googleFetch`; the egress gate has its own suite.
 */

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  ownedByMe: boolean;
  isAppAuthorized: boolean;
  trashed?: boolean;
  content?: string;
}

const FOLDER = 'application/vnd.google-apps.folder';
let drive: Map<string, FakeFile>;
let nextId: number;

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

/** The fields a request names, as Drive answers them. */
function pick(f: FakeFile, fields: string): Record<string, unknown> {
  const named = new Set((/files\(([^)]*)\)/.exec(fields)?.[1] ?? fields).split(','));
  const full: Record<string, unknown> = {
    id: f.id, name: f.name, mimeType: f.mimeType, ownedByMe: f.ownedByMe, isAppAuthorized: f.isAppAuthorized,
  };
  return Object.fromEntries(Object.entries(full).filter(([k]) => named.has(k)));
}

const mockGoogleFetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  const method = init?.method ?? 'GET';
  if (method === 'POST' && u.pathname === '/drive/v3/files') {
    const meta = JSON.parse(String(init?.body)) as { name: string; mimeType: string; parents?: string[] };
    const id = `new-${String(nextId++)}`;
    // Created by this app, owned by the user, in My Drive unless a parent is named.
    drive.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ['my-drive'], ownedByMe: true, isAppAuthorized: true });
    return respond(200, { id });
  }
  if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
    const text = Buffer.from(init?.body as Uint8Array).toString('utf8');
    const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(text)![1]!) as { name: string; parents: string[] };
    const id = `new-${String(nextId++)}`;
    drive.set(id, { id, name: meta.name, mimeType: 'application/octet-stream', parents: meta.parents, ownedByMe: true, isAppAuthorized: true });
    return respond(200, { id });
  }
  const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (method === 'GET' && media && u.searchParams.get('alt') === 'media') {
    const f = drive.get(decodeURIComponent(media[1]!));
    return f ? new Response(f.content ?? '', { status: 200 }) : respond(404);
  }
  if (method === 'GET' && u.pathname === '/drive/v3/files') {
    let rest = u.searchParams.get('q') ?? '';
    const take = (term: string): boolean => {
      if (!rest.includes(term)) return false;
      rest = rest.replace(term, '');
      return true;
    };
    const notTrashed = take(' and trashed = false');
    const mine = take(" and 'me' in owners");
    const byName = /^name = '([^']+)' and mimeType = '([^']+)'$/.exec(rest);
    const children = /^'([^']+)' in parents( and mimeType = '([^']+)')?( and name = '([^']+)')?$/.exec(rest);
    let matches: FakeFile[];
    if (byName) matches = [...drive.values()].filter(f => f.name === byName[1] && f.mimeType === byName[2]);
    else if (children) {
      matches = [...drive.values()].filter(f => f.parents.includes(children[1]!)
        && (children[3] === undefined || f.mimeType === children[3])
        && (children[5] === undefined || f.name === children[5]));
    } else throw new Error(`fake Drive: unexpected query ${u.searchParams.get('q') ?? ''}`);
    if (notTrashed) matches = matches.filter(f => f.trashed !== true);
    if (mine) matches = matches.filter(f => f.ownedByMe);
    const size = Number(u.searchParams.get('pageSize') ?? '100');
    const start = Number(u.searchParams.get('pageToken') ?? '0');
    const next = start + size < matches.length ? String(start + size) : undefined;
    const fields = u.searchParams.get('fields') ?? '';
    return respond(200, {
      files: matches.slice(start, start + size).map(f => pick(f, fields)),
      ...(next ? { nextPageToken: next } : {}),
    });
  }
  throw new Error(`fake Drive: unexpected ${method} ${u.pathname}`);
});

vi.mock('./connector-egress.js', async (importActual) => ({
  ...(await importActual<typeof import('./connector-egress.js')>()),
  googleFetch: (url: string, init?: RequestInit) => mockGoogleFetch(url, init),
}));

const { GDriveBackupUploader } = await import('./backup-upload-gdrive.js');
import type { BackupManifest } from '../types/index.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const auth = { getAccessToken: async () => 'access-token', hasScope: (s: string) => s === DRIVE_FILE };

function folder(id: string, owner: { ownedByMe: boolean; isAppAuthorized: boolean }, parents = ['my-drive']): void {
  drive.set(id, { id, name: 'lynox-backups', mimeType: FOLDER, parents, ...owner });
}

/** Where the uploaded files ended up: the lynox-backups folder above each one. */
function rootsWritten(): string[] {
  const roots = new Set<string>();
  for (const f of drive.values()) {
    if (f.mimeType === FOLDER) continue;
    const backup = drive.get(f.parents[0]!);
    if (backup) roots.add(backup.parents[0]!);
  }
  return [...roots];
}

let dir: string;
beforeEach(() => {
  drive = new Map();
  nextId = 1;
  mockGoogleFetch.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'lynox-drive-root-'));
  mkdirSync(join(dir, '2026-10-09T10000000Z'));
  writeFileSync(join(dir, '2026-10-09T10000000Z', 'history.db.enc'), 'cipher');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const upload = (u: InstanceType<typeof GDriveBackupUploader>) =>
  u.upload(join(dir, '2026-10-09T10000000Z'), {} as BackupManifest);

describe('the uploader writes only into a lynox-backups folder this app created and the user owns', () => {
  it('passes over a folder another account shared, even when it comes first, and uses the own one', async () => {
    folder('shared', { ownedByMe: false, isAppAuthorized: false });
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    const out = await upload(new GDriveBackupUploader(auth));
    expect(out.success).toBe(true);
    expect(rootsWritten()).toEqual(['own']);
  });

  it('creates its own folder when the only one of that name is shared', async () => {
    folder('shared', { ownedByMe: false, isAppAuthorized: false });
    const out = await upload(new GDriveBackupUploader(auth));
    expect(out.success).toBe(true);
    const [root] = rootsWritten();
    expect(root).not.toBe('shared');
    expect(drive.get(root!)).toMatchObject({ name: 'lynox-backups', ownedByMe: true, isAppAuthorized: true, parents: ['my-drive'] });
  });

  it('passes over a shared folder this app has opened — owned by someone else is not ours', async () => {
    // `isAppAuthorized` is per OAuth app, and the managed client is one app for every tenant:
    // another tenant's folder, shared in, reads as authorized.
    folder('other-tenant', { ownedByMe: false, isAppAuthorized: true });
    await upload(new GDriveBackupUploader(auth));
    expect(rootsWritten()).not.toContain('other-tenant');
  });

  it('passes over a folder the user made by hand — not one this app created', async () => {
    folder('by-hand', { ownedByMe: true, isAppAuthorized: false });
    await upload(new GDriveBackupUploader(auth));
    expect(rootsWritten()).not.toContain('by-hand');
  });

  it('asks once when the first page is the last, and creates its own folder', async () => {
    folder('shared', { ownedByMe: false, isAppAuthorized: false });
    await upload(new GDriveBackupUploader(auth));
    const lookups = mockGoogleFetch.mock.calls.filter(([url]) => new URL(url).searchParams.get('q')?.startsWith("name = 'lynox-backups'"));
    expect(lookups).toHaveLength(1);
  });

  it('stops paging a listing that never ends, and creates its own folder', async () => {
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (new URL(url).searchParams.get('q')?.startsWith("name = 'lynox-backups'")) {
        return respond(200, { files: [], nextPageToken: 'again' });
      }
      return real(url, init);
    });
    try {
      const out = await upload(new GDriveBackupUploader(auth));
      expect(out.success).toBe(true);
      expect(rootsWritten()).toHaveLength(1);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('finds its own folder behind a full page of others', async () => {
    for (let i = 0; i < 120; i++) folder(`by-hand-${String(i)}`, { ownedByMe: true, isAppAuthorized: false });
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    await upload(new GDriveBackupUploader(auth));
    expect(rootsWritten()).toEqual(['own']);
  });
});

describe('the uploader lists backups only from a folder this app created and the user owns', () => {
  it('does not list a backup kept in a folder another account shared', async () => {
    folder('shared', { ownedByMe: false, isAppAuthorized: false });
    drive.set('theirs', { id: 'theirs', name: '2026-10-01T00000000Z', mimeType: FOLDER, parents: ['shared'], ownedByMe: false, isAppAuthorized: false });
    drive.set('pm', { id: 'pm', name: 'manifest.json', mimeType: 'application/json', parents: ['theirs'], ownedByMe: false, isAppAuthorized: false, content: '{"created_at":"2026-10-01T00:00:00.000Z"}' });
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    drive.set('mine', { id: 'mine', name: '2026-10-08T00000000Z', mimeType: FOLDER, parents: ['own'], ownedByMe: true, isAppAuthorized: true });
    const listed = await new GDriveBackupUploader(auth).list();
    expect(listed.map(b => b.id)).toEqual(['mine']);
  });

  it('lists nothing when the only folder of that name is shared', async () => {
    folder('shared', { ownedByMe: false, isAppAuthorized: false });
    drive.set('theirs', { id: 'theirs', name: '2026-10-01T00000000Z', mimeType: FOLDER, parents: ['shared'], ownedByMe: false, isAppAuthorized: false });
    expect(await new GDriveBackupUploader(auth).list()).toEqual([]);
  });
});
