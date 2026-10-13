import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Which `lynox-backups` folder the uploader writes into and lists from, against an in-memory
 * Drive. The uploader finds its root only through its pin. A listing by name, which the deletion
 * on disconnect uses, also returns folders other accounts shared with the user under the full
 * `drive` scope. The fake returns every folder regardless of the granted scope, the strict case,
 * and in insertion order, so a folder inserted first is the first a listing sees.
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
    trashed: f.trashed ?? false, parents: f.parents,
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
  if (method === 'DELETE' && media) {
    return drive.delete(decodeURIComponent(media[1]!)) ? new Response(null, { status: 204 }) : respond(404);
  }
  if (method === 'GET' && media && u.searchParams.get('alt') === 'media') {
    const f = drive.get(decodeURIComponent(media[1]!));
    return f ? new Response(f.content ?? '', { status: 200 }) : respond(404);
  }
  if (method === 'GET' && media) {
    const f = drive.get(decodeURIComponent(media[1]!));
    return f ? respond(200, pick(f, u.searchParams.get('fields') ?? '')) : respond(404);
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

const { GDriveBackupUploader, deleteUploadedBackups, fileRootPin, localPathFor } = await import('./backup-upload-gdrive.js');
import type { RootFolderPin } from './backup-upload-gdrive.js';
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

/** A pin held in memory, so a test can read what the uploader kept and hand it to a new one. */
function memPin(value: string | null = null): RootFolderPin & { value: string | null } {
  const pin = {
    value,
    read: () => pin.value,
    write: (id: string) => { pin.value = id; },
  };
  return pin;
}

const NAME_LOOKUP = "name = 'lynox-backups'";
/** Every folder or file the uploader asked Drive to create. */
const creates = () => mockGoogleFetch.mock.calls
  .filter(([url, init]) => init?.method === 'POST' && new URL(url).pathname.endsWith('/drive/v3/files'));
const nameLookups = (from = 0) => mockGoogleFetch.mock.calls.slice(from)
  .filter(([url]) => new URL(url).searchParams.get('q')?.startsWith(NAME_LOOKUP));

describe('the uploader never takes a root by its name', () => {
  it.each([
    ['owned by the user and authorized for this app', { ownedByMe: true, isAppAuthorized: true }],
    ['shared by another account', { ownedByMe: false, isAppAuthorized: false }],
    ['shared in and authorized for this app', { ownedByMe: false, isAppAuthorized: true }],
    ['made by hand', { ownedByMe: true, isAppAuthorized: false }],
  ])('a folder not created by this instance is never adopted (%s), and a new root is pinned', async (_what, owner) => {
    folder('existing', owner);
    const pin = memPin();
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(out.success).toBe(true);
    const [root] = rootsWritten();
    expect(root).toMatch(/^new-/);
    expect(drive.get(root!)).toMatchObject({ name: 'lynox-backups', ownedByMe: true, isAppAuthorized: true, parents: ['my-drive'] });
    expect(pin.value).toBe(root);
  });

  it('does not list folders by name to find its root', async () => {
    folder('existing', { ownedByMe: true, isAppAuthorized: true });
    await upload(new GDriveBackupUploader(auth, { rootPin: memPin() }));
    expect(nameLookups()).toHaveLength(0);
  });

  it('lists nothing without a pin, and creates nothing', async () => {
    folder('existing', { ownedByMe: true, isAppAuthorized: true });
    drive.set('b', { id: 'b', name: '2026-10-08T00000000Z', mimeType: FOLDER, parents: ['existing'], ownedByMe: true, isAppAuthorized: true });
    const before = drive.size;
    expect(await new GDriveBackupUploader(auth, { rootPin: memPin() }).list()).toEqual([]);
    expect(await new GDriveBackupUploader(auth).list()).toEqual([]);
    expect(drive.size).toBe(before);
  });

  it('a disconnect still deletes the backups in the root of an earlier start, beside the new one', async () => {
    // The root an install used before it had a pin: its backups are no longer the uploader's,
    // and only the deletion's own lookup by name reaches them.
    folder('earlier', { ownedByMe: true, isAppAuthorized: true });
    drive.set('old', { id: 'old', name: '2026-10-01T00000000Z', mimeType: FOLDER, parents: ['earlier'], ownedByMe: true, isAppAuthorized: true });
    drive.set('old-f', { id: 'old-f', name: 'history.db.enc', mimeType: 'application/octet-stream', parents: ['old'], ownedByMe: true, isAppAuthorized: true });
    await upload(new GDriveBackupUploader(auth, { rootPin: memPin() }));
    expect(rootsWritten().sort()).toEqual(['earlier', 'new-1']);
    const res = await deleteUploadedBackups(auth);
    expect(res.problems).toEqual([]);
    expect(res.deleted).toBe(2);
    expect([...drive.values()].filter(f => f.mimeType !== FOLDER)).toEqual([]);
  });

  it('refuses to upload without a place to keep the root, and creates nothing', async () => {
    const out = await upload(new GDriveBackupUploader(auth));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/No place to keep/);
    expect(drive.size).toBe(0);
  });
});

describe('once a root is pinned, the uploader keeps it', () => {
  it('takes the pinned root over a folder of the same name that a listing returns first', async () => {
    // A folder of the same name the user owns and this app is authorized for, inserted first,
    // so a lookup by name would find it.
    folder('transferred', { ownedByMe: true, isAppAuthorized: true });
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: memPin('own') }));
    expect(out.success).toBe(true);
    expect(rootsWritten()).toEqual(['own']);
  });

  it('pins the root it creates, and a restart takes it again', async () => {
    const pin = memPin();
    await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    const [created] = rootsWritten();
    expect(pin.value).toBe(created);
    // A folder of that name appears, and the next instance is started with the same pin.
    folder('transferred', { ownedByMe: true, isAppAuthorized: true });
    const listed = mockGoogleFetch.mock.calls.length;
    await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(rootsWritten()).toEqual([created]);
    const lookups = mockGoogleFetch.mock.calls.slice(listed)
      .filter(([url]) => new URL(url).searchParams.get('q')?.startsWith("name = 'lynox-backups'"));
    expect(lookups, 'a pinned root is not looked up by name').toHaveLength(0);
  });

  it.each([
    ['in the bin', { ownedByMe: true, isAppAuthorized: true, trashed: true }],
    ['no longer the user\'s', { ownedByMe: false, isAppAuthorized: true }],
    ['not created by this app', { ownedByMe: true, isAppAuthorized: false }],
  ])('creates a new root when the pinned one is %s, and does not take one by name', async (_what, state) => {
    drive.set('pinned', { id: 'pinned', name: 'lynox-backups', mimeType: FOLDER, parents: ['my-drive'], ...state });
    folder('other', { ownedByMe: true, isAppAuthorized: true });
    const pin = memPin('pinned');
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(out.success).toBe(true);
    const [root] = rootsWritten();
    expect(root).not.toBe('pinned');
    expect(root).not.toBe('other');
    expect(pin.value).toBe(root);
  });

  it('creates and pins a new root when this account does not see the pinned one, beside a folder of that name', async () => {
    // A pin from another Google account the instance was connected to, or a root deleted for
    // good: Drive answers 404 for it. A folder of that name is still not taken.
    folder('this-account', { ownedByMe: true, isAppAuthorized: true });
    const pin = memPin('other-account-root');
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(out.success).toBe(true);
    const [root] = rootsWritten();
    expect(root).toMatch(/^new-/);
    expect(pin.value).toBe(root);
    expect(nameLookups()).toHaveLength(0);
  });

  it('does not take a pinned id that names a file, not a folder', async () => {
    drive.set('a-file', { id: 'a-file', name: 'lynox-backups', mimeType: 'text/plain', parents: ['my-drive'], ownedByMe: true, isAppAuthorized: true });
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: memPin('a-file') }));
    expect(out.success).toBe(true);
    expect(rootsWritten()).not.toContain('a-file');
  });

  it('takes a pinned folder whose answer leaves out `trashed`', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if ((init?.method ?? 'GET') === 'GET' && u.pathname === '/drive/v3/files/own' && u.searchParams.get('alt') !== 'media') {
        return respond(200, { id: 'own', mimeType: FOLDER, ownedByMe: true, isAppAuthorized: true });
      }
      return real(url, init);
    });
    try {
      await upload(new GDriveBackupUploader(auth, { rootPin: memPin('own') }));
      expect(rootsWritten()).toEqual(['own']);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('fails the upload and creates nothing when Drive cannot say what the pinned folder is', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if ((init?.method ?? 'GET') === 'GET' && u.pathname === '/drive/v3/files/own' && u.searchParams.get('alt') !== 'media') return respond(503);
      return real(url, init);
    });
    try {
      const before = drive.size;
      const out = await upload(new GDriveBackupUploader(auth, { rootPin: memPin('own') }));
      expect(out.success).toBe(false);
      expect(drive.size).toBe(before);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('lists backups only from the pinned root', async () => {
    folder('transferred', { ownedByMe: true, isAppAuthorized: true });
    drive.set('theirs', { id: 'theirs', name: '2026-10-01T00000000Z', mimeType: FOLDER, parents: ['transferred'], ownedByMe: true, isAppAuthorized: true });
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    drive.set('mine', { id: 'mine', name: '2026-10-08T00000000Z', mimeType: FOLDER, parents: ['own'], ownedByMe: true, isAppAuthorized: true });
    const listed = await new GDriveBackupUploader(auth, { rootPin: memPin('own') }).list();
    expect(listed.map(b => b.id)).toEqual(['mine']);
  });

  it('lists nothing and creates nothing when the pinned root is no longer this instance\'s', async () => {
    drive.set('pinned', { id: 'pinned', name: 'lynox-backups', mimeType: FOLDER, parents: ['my-drive'], ownedByMe: true, isAppAuthorized: true, trashed: true });
    drive.set('old', { id: 'old', name: '2026-10-01T00000000Z', mimeType: FOLDER, parents: ['pinned'], ownedByMe: true, isAppAuthorized: true });
    folder('other', { ownedByMe: true, isAppAuthorized: true });
    drive.set('theirs', { id: 'theirs', name: '2026-10-02T00000000Z', mimeType: FOLDER, parents: ['other'], ownedByMe: true, isAppAuthorized: true });
    const before = drive.size;
    expect(await new GDriveBackupUploader(auth, { rootPin: memPin('pinned') }).list()).toEqual([]);
    expect(drive.size).toBe(before);
  });

  it('fails the upload when the pin cannot be written, and deletes the root it just created', async () => {
    folder('existing', { ownedByMe: true, isAppAuthorized: true });
    const pin: RootFolderPin = { read: () => null, write: () => { throw new Error('disk full'); } };
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Could not keep the lynox-backups folder id: disk full\. The folder just created was deleted again\./);
    expect([...drive.keys()]).toEqual(['existing']);
    const deletes = mockGoogleFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => new URL(url).pathname);
    expect(deletes, 'only the folder this call created, by its id').toEqual(['/drive/v3/files/new-1']);
  });

  it('creates nothing more on a second upload after the pin could not be written', async () => {
    const pin: RootFolderPin = { read: () => null, write: () => { throw new Error('disk full'); } };
    const u = new GDriveBackupUploader(auth, { rootPin: pin });
    expect((await upload(u)).success).toBe(false);
    const out = await upload(u);
    expect(out.success).toBe(false);
    expect(drive.size).toBe(0);
  });

  it('fails the upload, and pins nothing, when Drive answers the new folder without an id', async () => {
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(url).pathname === '/drive/v3/files') return respond(200, {});
      return real(url, init);
    });
    try {
      const pin = memPin();
      const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/did not return a usable id for the new lynox-backups folder; it may be left in Drive/);
      expect(pin.value).toBeNull();
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('names both failures when the root it just created cannot be deleted either', async () => {
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return respond(500);
      return real(url, init);
    });
    try {
      const pin: RootFolderPin = { read: () => null, write: () => { throw new Error('disk full'); } };
      const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/Could not keep the lynox-backups folder id: disk full\. The folder just created \(new-1\) could not be deleted and is left in Drive\./);
      expect(rootsWritten()).toEqual([]);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });
});

describe('fileRootPin', () => {
  it('keeps the id in a file only the owner can read, and reads it back', () => {
    const pin = fileRootPin(join(dir, 'data'));
    expect(pin.read()).toBeNull();
    pin.write('1AbC_d-9');
    expect(pin.read()).toBe('1AbC_d-9');
    expect(statSync(join(dir, 'data', 'gdrive-backup-root')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'data', 'gdrive-backup-root'), 'utf8')).toBe('1AbC_d-9\n');
  });

  it('replaces the file rather than writing into it, so a reader never sees half an id', () => {
    // A file that cannot be written in place, but can be replaced in its directory.
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'gdrive-backup-root'), 'old-id\n', { mode: 0o400 });
    const pin = fileRootPin(join(dir, 'data'));
    pin.write('new-id');
    expect(pin.read()).toBe('new-id');
    expect(readdirSync(join(dir, 'data'))).toEqual(['gdrive-backup-root']);
  });

  it('reads anything that is not a Drive id as no pin', () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'gdrive-backup-root'), "x' or name = 'y\n");
    expect(fileRootPin(join(dir, 'data')).read()).toBeNull();
  });

  it('fails, rather than reading no pin, when the pin cannot be read; an upload then creates nothing', async () => {
    // A path that exists but cannot be read as a file (EISDIR), standing in for EACCES or EIO.
    mkdirSync(join(dir, 'data', 'gdrive-backup-root'), { recursive: true });
    const pin = fileRootPin(join(dir, 'data'));
    expect(() => pin.read()).toThrow();
    expect(fileRootPin(join(dir, 'absent')).read()).toBeNull();
    const out = await upload(new GDriveBackupUploader(auth, { rootPin: pin }));
    expect(out.success).toBe(false);
    expect(creates(), 'no folder is created, not even one deleted again').toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('keeps a pin it cannot read rather than writing a new one over it', async () => {
    mkdirSync(join(dir, 'data'));
    const file = join(dir, 'data', 'gdrive-backup-root');
    writeFileSync(file, 'good-id\n', { mode: 0o000 });
    try {
      const out = await upload(new GDriveBackupUploader(auth, { rootPin: fileRootPin(join(dir, 'data')) }));
      expect(out.success).toBe(false);
      expect(creates()).toEqual([]);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, 'utf8')).toBe('good-id\n');
  });
});

/** A backup folder under `parent` holding files named as given, as the uploader would write them. */
function backup(id: string, parent: string, files: Record<string, string>, owner = { ownedByMe: true, isAppAuthorized: true }): void {
  drive.set(id, { id, name: '2026-10-08T00000000Z', mimeType: FOLDER, parents: [parent], ...owner });
  let n = 0;
  for (const [name, content] of Object.entries(files)) {
    const fid = `${id}-f${String(n++)}`;
    drive.set(fid, { id: fid, name, mimeType: 'application/octet-stream', parents: [id], ...owner, content });
  }
}

/** Every file below `root`, as paths relative to it. */
function filesBelow(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesBelow(root, rel) : [rel];
  });
}

const mediaReads = () => mockGoogleFetch.mock.calls.filter(([url]) => new URL(url).searchParams.get('alt') === 'media');

/** An uploader whose pinned root is `own`, the folder these tests put their backups in. */
const ownUploader = () => new GDriveBackupUploader(auth, { rootPin: memPin('own') });

describe('download and delete take only a backup folder under the own root', () => {
  it('round-trips an upload with a subdirectory: the uploader names files by their relative path', async () => {
    mkdirSync(join(dir, '2026-10-09T10000000Z', 'files'));
    writeFileSync(join(dir, '2026-10-09T10000000Z', 'files', 'note.txt'), 'n');
    const u = ownUploader();
    const up = await upload(u);
    const out = await u.download(up.folderId, join(dir, 'restore'));
    expect(out).toMatchObject({ success: true, filesDownloaded: 2 });
    expect(filesBelow(join(dir, 'restore')).sort()).toEqual(['files/note.txt', 'history.db.enc']);
  });

  it('downloads a backup under the own root', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('mine', 'own', { 'history.db.enc': 'c' });
    const out = await ownUploader().download('mine', join(dir, 'restore'));
    expect(out).toMatchObject({ success: true, filesDownloaded: 1 });
    expect(readFileSync(join(dir, 'restore', 'history.db.enc'), 'utf8')).toBe('c');
  });

  it.each([
    ['in a folder another account shared', 'theirs', () => {
      folder('shared', { ownedByMe: false, isAppAuthorized: false });
      backup('theirs', 'shared', { 'history.db.enc': 'x' }, { ownedByMe: false, isAppAuthorized: false });
    }],
    ['elsewhere in the account', 'loose', () => { backup('loose', 'my-drive', { 'history.db.enc': 'x' }); }],
    ['the root itself', 'own', () => { /* the root from below */ }],
    ['in the bin', 'binned', () => {
      backup('binned', 'own', { 'history.db.enc': 'x' });
      drive.get('binned')!.trashed = true;
    }],
    ['a file, not a folder', 'own-f0', () => { /* the file of `mine` below */ }],
    ['unknown to Drive', 'nowhere', () => { /* nothing */ }],
  ])('refuses a folder %s: nothing is read and nothing written', async (_what, id, arrange) => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('own-mine', 'own', { 'history.db.enc': 'mine' });
    drive.set('own-f0', { id: 'own-f0', name: 'x', mimeType: 'application/octet-stream', parents: ['own'], ownedByMe: true, isAppAuthorized: true, content: 'x' });
    arrange();
    const out = await ownUploader().download(id, join(dir, 'restore'));
    expect(out.success).toBe(false);
    expect(mediaReads()).toHaveLength(0);
    expect(readdirSync(dir)).not.toContain('restore');
    expect(await ownUploader().delete(id)).toBe(false);
    if (id !== 'nowhere') expect(drive.has(id), 'still in Drive').toBe(true);
  });

  it('refuses everything when the account has no own root', async () => {
    backup('loose', 'my-drive', { 'history.db.enc': 'x' });
    const u = ownUploader();
    expect((await u.download('loose', join(dir, 'restore'))).success).toBe(false);
    expect(await u.delete('loose')).toBe(false);
    expect(drive.has('loose')).toBe(true);
  });

  it('deletes a backup under the own root', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('mine', 'own', {});
    expect(await ownUploader().delete('mine')).toBe(true);
    expect(drive.has('mine')).toBe(false);
  });

  it('fails, rather than proceeding, when Drive cannot say what the folder is', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('mine', 'own', { 'history.db.enc': 'c' });
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/drive/v3/files/mine' && (init?.method ?? 'GET') === 'GET' && u.searchParams.get('alt') !== 'media') return respond(503);
      return real(url, init);
    });
    try {
      const u = ownUploader();
      expect((await u.download('mine', join(dir, 'restore'))).success).toBe(false);
      expect(mediaReads()).toHaveLength(0);
      expect(await u.delete('mine')).toBe(false);
      expect(drive.has('mine')).toBe(true);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });
});

describe('download keeps every Drive file name inside the target directory', () => {
  it.each([
    ['a parent step', '../escaped'],
    ['a parent step inside a path', 'files/../../escaped'],
    // Inside the test's own directory, so a mutant that lets it through cannot write elsewhere.
    ['an absolute path', 'ABSOLUTE'],
  ])('fails on %s and writes no file anywhere, not even the harmless ones', async (_what, spec) => {
    const name = spec === 'ABSOLUTE' ? join(dir, 'escaped') : spec;
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('mine', 'own', { 'history.db.enc': 'c', [name]: 'evil' });
    const target = join(dir, 'a', 'restore');
    mkdirSync(join(dir, 'a'));
    const out = await ownUploader().download('mine', target);
    expect(out.success).toBe(false);
    expect(out.error).toContain('Refusing Drive file name');
    expect(filesBelow(dir).sort()).toEqual(['2026-10-09T10000000Z/history.db.enc']);
    expect(mediaReads()).toHaveLength(0);
  });

  it('fails on a subfolder named as a parent step', async () => {
    folder('own', { ownedByMe: true, isAppAuthorized: true });
    backup('mine', 'own', {});
    drive.set('up', { id: 'up', name: '..', mimeType: FOLDER, parents: ['mine'], ownedByMe: true, isAppAuthorized: true });
    drive.set('up-f', { id: 'up-f', name: 'escaped', mimeType: 'application/octet-stream', parents: ['up'], ownedByMe: true, isAppAuthorized: true, content: 'evil' });
    mkdirSync(join(dir, 'a'));
    const out = await ownUploader().download('mine', join(dir, 'a', 'restore'));
    expect(out.success).toBe(false);
    expect(filesBelow(dir)).not.toContain('a/escaped');
    expect(mediaReads()).toHaveLength(0);
  });

  it.each([
    ['../x'], ['a/../../x'], ['/etc/x'], ['/srv/restore-other/x'], ['a/..'], [''], ['.'], ['..'],
    // Spellings that stay inside but are not the canonical path: two of them could name one file.
    ['a/../b'], ['./a'], ['a//b'], ['a/'], ['/srv/restore/x'],
  ])('localPathFor refuses %j', (name) => {
    expect(() => localPathFor('/srv/restore', name)).toThrow(/Refusing Drive file name/);
  });

  it.each([
    ['history.db.enc', '/srv/restore/history.db.enc'],
    ['files/sub/note.txt', '/srv/restore/files/sub/note.txt'],
    ['..hidden', '/srv/restore/..hidden'],
  ])('localPathFor maps %j below the target', (name, path) => {
    expect(localPathFor('/srv/restore', name)).toBe(path);
  });

  it('localPathFor takes the filesystem root as a target', () => {
    expect(localPathFor('/', 'x')).toBe('/x');
    expect(localPathFor('/srv/restore/', 'x'), 'a trailing slash on the target').toBe('/srv/restore/x');
  });
});

describe('download writes nothing unless the whole backup checks out', () => {
  const own = { ownedByMe: true, isAppAuthorized: true };

  it('fails on a bad name two levels down and writes no file, not even the top-level ones', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    drive.set('sub', { id: 'sub', name: 'files', mimeType: FOLDER, parents: ['mine'], ...own });
    drive.set('sub-f', { id: 'sub-f', name: '../../escaped', mimeType: 'application/octet-stream', parents: ['sub'], ...own, content: 'evil' });
    mkdirSync(join(dir, 'a'));
    const out = await ownUploader().download('mine', join(dir, 'a', 'restore'));
    expect(out.success).toBe(false);
    expect(mediaReads()).toHaveLength(0);
    expect(readdirSync(join(dir, 'a'))).toEqual([]);
  });

  it('downloads a nested subfolder', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    drive.set('sub', { id: 'sub', name: 'files', mimeType: FOLDER, parents: ['mine'], ...own });
    drive.set('sub-f', { id: 'sub-f', name: 'note.txt', mimeType: 'application/octet-stream', parents: ['sub'], ...own, content: 'n' });
    const out = await ownUploader().download('mine', join(dir, 'restore'));
    expect(out).toMatchObject({ success: true, filesDownloaded: 2 });
    expect(filesBelow(join(dir, 'restore')).sort()).toEqual(['files/note.txt', 'history.db.enc']);
  });

  it.each([
    ['owned by someone else', { ownedByMe: false, isAppAuthorized: true }],
    ['not written by this app', { ownedByMe: true, isAppAuthorized: false }],
  ])('refuses a backup with a file %s in it — someone who can write into the folder added it', async (_what, owner) => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    drive.set('added', { id: 'added', name: 'config.json', mimeType: 'application/octet-stream', parents: ['mine'], ...owner, content: '{}' });
    const out = await ownUploader().download('mine', join(dir, 'restore'));
    expect(out.success).toBe(false);
    expect(out.error).toContain('not one this app wrote');
    expect(mediaReads()).toHaveLength(0);
  });

  it.each([
    ['owned by someone else', { ownedByMe: false, isAppAuthorized: true }],
    ['not created by this app', { ownedByMe: true, isAppAuthorized: false }],
  ])('refuses a backup folder in the own root that is %s', async (_what, owner) => {
    folder('own', own);
    backup('added', 'own', { 'history.db.enc': 'x' }, owner);
    const u = ownUploader();
    expect((await u.download('added', join(dir, 'restore'))).success).toBe(false);
    expect(mediaReads()).toHaveLength(0);
    expect(await u.delete('added')).toBe(false);
    expect(drive.has('added')).toBe(true);
  });

  it('refuses two entries that land on the same path', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    drive.set('dup', { id: 'dup', name: 'history.db.enc', mimeType: 'application/octet-stream', parents: ['mine'], ...own, content: 'other' });
    const out = await ownUploader().download('mine', join(dir, 'restore'));
    expect(out.success).toBe(false);
    expect(out.error).toContain('a second entry');
    expect(mediaReads()).toHaveLength(0);
  });

  it('refuses a target directory that is not empty, and takes an empty one', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    mkdirSync(join(dir, 'full'));
    writeFileSync(join(dir, 'full', 'keep'), 'k');
    const u = ownUploader();
    const out = await u.download('mine', join(dir, 'full'));
    expect(out.success).toBe(false);
    expect(out.error).toContain('not empty');
    expect(readdirSync(join(dir, 'full'))).toEqual(['keep']);
    mkdirSync(join(dir, 'empty'));
    expect((await u.download('mine', join(dir, 'empty'))).success).toBe(true);
  });

  it('does not write through a symlink planted in the target after it was checked empty', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    writeFileSync(join(dir, 'outside'), 'untouched');
    const target = join(dir, 'restore');
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      // While the tree is listed, after the emptiness check and before the first write.
      if (new URL(url).searchParams.get('q') === "'mine' in parents and trashed = false") {
        mkdirSync(target);
        symlinkSync(join(dir, 'outside'), join(target, 'history.db.enc'));
      }
      return real(url, init);
    });
    try {
      const out = await ownUploader().download('mine', target);
      expect(out.success).toBe(false);
      expect(readFileSync(join(dir, 'outside'), 'utf8')).toBe('untouched');
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('fails, rather than reporting fewer files, when a listing does not answer', async () => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    const real = mockGoogleFetch.getMockImplementation()!;
    mockGoogleFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (new URL(url).searchParams.get('q') === "'mine' in parents and trashed = false") return respond(503);
      return real(url, init);
    });
    try {
      const out = await ownUploader().download('mine', join(dir, 'restore'));
      expect(out.success).toBe(false);
    } finally {
      mockGoogleFetch.mockImplementation(real);
    }
  });

  it('reads every page of a large folder', async () => {
    folder('own', own);
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) files[`f${String(i)}`] = String(i);
    backup('mine', 'own', files);
    const out = await ownUploader().download('mine', join(dir, 'restore'));
    expect(out).toMatchObject({ success: true, filesDownloaded: 250 });
  });

  it.each([["x' or name = 'y"], ['own/../mine'], ['mine?alt=media'], ['']])('refuses the id %j before asking Drive anything', async (id) => {
    folder('own', own);
    backup('mine', 'own', { 'history.db.enc': 'c' });
    const u = ownUploader();
    expect((await u.download(id, join(dir, 'restore'))).success).toBe(false);
    expect(await u.delete(id)).toBe(false);
    expect(mockGoogleFetch).not.toHaveBeenCalled();
    expect(drive.has('mine')).toBe(true);
  });
});
