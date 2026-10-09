import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `deleteUploadedBackups` against an in-memory Drive.
 *
 * The fake implements the Drive rules the design rests on: `files.delete` on a folder
 * removes every descendant the user owns (which is what makes a folder delete destroy the
 * user's own copy), a listing honours `trashed = false` and `'me' in owners` when asked, and
 * pages. A fake without the cascade would let an implementation that deletes folders pass.
 * The transport is mocked at `googleFetch`; the egress gate in front of it has its own suite
 * (`connector-egress.test.ts`).
 */

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  isAppAuthorized?: boolean | undefined;
  trashed?: boolean;
  /** `null` leaves the field out of the listing, as an answer without it would. */
  ownedByMe?: boolean | null;
}

const FOLDER = 'application/vnd.google-apps.folder';
const BIN = 'application/octet-stream';
let drive: Map<string, FakeFile>;
let pageSize: number;
let failList: (q: string) => number | null;
let failDelete: (id: string) => number | null;
let badJson: (q: string) => boolean;

function descendants(id: string): string[] {
  const out: string[] = [];
  for (const f of drive.values()) {
    if (f.parents.includes(id)) out.push(f.id, ...descendants(f.id));
  }
  return out;
}

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const mockGoogleFetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  const method = init?.method ?? 'GET';
  const del = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (method === 'DELETE' && del) {
    const id = decodeURIComponent(del[1]!);
    const forced = failDelete(id);
    if (forced !== null) return respond(forced);
    if (!drive.has(id)) return respond(404);
    for (const d of [id, ...descendants(id)]) drive.delete(d);
    return respond(204);
  }
  if (method === 'GET' && u.pathname === '/drive/v3/files') {
    const q = u.searchParams.get('q') ?? '';
    const forced = failList(q);
    if (forced !== null) return respond(forced);
    if (badJson(q)) return new Response('<html>not json</html>', { status: 200 });
    let rest = q;
    const take = (suffix: string): boolean => {
      if (!rest.endsWith(suffix)) return false;
      rest = rest.slice(0, -suffix.length);
      return true;
    };
    const notTrashed = take(' and trashed = false');
    const mine = take(" and 'me' in owners");
    const inParents = /^'([^']+)' in parents$/.exec(rest);
    const byName = /^name = '([^']+)' and mimeType = '([^']+)'$/.exec(rest);
    let matches: FakeFile[];
    if (inParents) matches = [...drive.values()].filter(f => f.parents.includes(inParents[1]!));
    else if (byName) matches = [...drive.values()].filter(f => f.name === byName[1] && f.mimeType === byName[2]);
    else throw new Error(`fake Drive: unexpected query ${q}`);
    if (notTrashed) matches = matches.filter(f => f.trashed !== true);
    if (mine) matches = matches.filter(f => f.ownedByMe !== false);
    const start = Number(u.searchParams.get('pageToken') ?? '0');
    const slice = matches.slice(start, start + pageSize);
    const next = start + pageSize < matches.length ? String(start + pageSize) : undefined;
    // Drive answers with the fields the request names, and no others. A fake that always
    // sent every field would let a request that forgot one pass every test.
    const named = new Set((/files\(([^)]*)\)/.exec(u.searchParams.get('fields') ?? '')?.[1] ?? '').split(','));
    const full = (f: FakeFile): Record<string, unknown> => ({
      id: f.id, name: f.name, mimeType: f.mimeType,
      ...(f.isAppAuthorized === undefined ? {} : { isAppAuthorized: f.isAppAuthorized }),
      ...(f.ownedByMe === null ? {} : { ownedByMe: f.ownedByMe !== false }),
    });
    return respond(200, {
      files: slice.map(f => Object.fromEntries(Object.entries(full(f)).filter(([k]) => named.has(k)))),
      ...(next ? { nextPageToken: next } : {}),
    });
  }
  throw new Error(`fake Drive: unexpected ${method} ${u.pathname}`);
});

vi.mock('./connector-egress.js', async (importActual) => ({
  ...(await importActual<typeof import('./connector-egress.js')>()),
  googleFetch: (url: string, init?: RequestInit) => mockGoogleFetch(url, init),
}));

const { deleteUploadedBackups } = await import('./backup-upload-gdrive.js');

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';
const auth = (scopes: string[] = [DRIVE_FILE]) => ({
  getAccessToken: async () => 'access-token',
  hasScope: (s: string) => scopes.includes(s),
});

/** Created by lynox unless the record says otherwise. */
function add(f: FakeFile): void {
  drive.set(f.id, 'isAppAuthorized' in f ? f : { ...f, isAppAuthorized: true });
}

/**
 * What `GDriveBackupUploader.upload` builds: lynox-backups / <backup dir name> / flat files
 * (nested paths become names with slashes). Plus the user's own copy next to a backup file.
 */
function seedOneBackup(): void {
  add({ id: 'root', name: 'lynox-backups', mimeType: FOLDER, parents: ['my-drive'] });
  add({ id: 'b1', name: '2026-10-08T19301234Z', mimeType: FOLDER, parents: ['root'] });
  add({ id: 'm', name: 'manifest.json', mimeType: 'application/json', parents: ['b1'] });
  add({ id: 'h', name: 'history.db.enc', mimeType: BIN, parents: ['b1'] });
  add({ id: 'n', name: 'memory/notes.md.enc', mimeType: BIN, parents: ['b1'] });
  // "Make a copy" in Drive puts the copy next to the original. Not created by lynox.
  add({ id: 'copy', name: 'Copy of history.db.enc', mimeType: BIN, parents: ['b1'], isAppAuthorized: false });
}

beforeEach(() => {
  drive = new Map();
  pageSize = 1000;
  failList = () => null;
  failDelete = () => null;
  badJson = () => false;
  mockGoogleFetch.mockClear();
});

describe('deleteUploadedBackups — what it deletes', () => {
  it('deletes the backup files lynox uploaded, and leaves the folders and the user\'s copy', async () => {
    seedOneBackup();
    const res = await deleteUploadedBackups(auth());
    expect(res).toEqual({ status: 'deleted', deleted: 3, foldersKept: 2, problems: [] });
    for (const id of ['m', 'h', 'n']) expect(drive.has(id), `${id} survived`).toBe(false);
    // The user's copy is the reason folders are never deleted: Drive would take it along.
    expect(drive.has('copy'), 'the user\'s own copy was deleted').toBe(true);
    for (const id of ['root', 'b1']) expect(drive.has(id), `folder ${id} was deleted`).toBe(true);
  });

  it('deletes a backup in the bin, and one under a second lynox-backups folder', async () => {
    seedOneBackup();
    drive.get('h')!.trashed = true;
    add({ id: 'root2', name: 'lynox-backups', mimeType: FOLDER, parents: ['my-drive'] });
    add({ id: 'b2', name: '2026-10-09T08000000Z-2', mimeType: FOLDER, parents: ['root2'] });
    add({ id: 'x', name: 'manifest.json', mimeType: 'application/json', parents: ['b2'] });
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('deleted');
    expect(drive.has('h'), 'the binned backup survived').toBe(false);
    expect(drive.has('x'), 'the second root was not walked').toBe(false);
  });

  it('touches nothing outside the structure the uploader builds, even when lynox created it', async () => {
    seedOneBackup();
    // lynox creates files for other reasons too (the agent's Drive, Docs and Sheets tools).
    add({ id: 'inRoot', name: 'report.pdf', mimeType: 'application/pdf', parents: ['root'] });
    add({ id: 'odd', name: 'Projects', mimeType: FOLDER, parents: ['root'] });
    add({ id: 'inOdd', name: 'plan.docx', mimeType: BIN, parents: ['odd'] });
    add({ id: 'nested', name: 'deeper', mimeType: FOLDER, parents: ['b1'] });
    add({ id: 'inNested', name: 'draft.docx', mimeType: BIN, parents: ['nested'] });
    add({ id: 'elsewhere', name: 'report.pdf', mimeType: 'application/pdf', parents: ['my-drive'] });
    // A backup-named folder lynox did not create, holding a file lynox did.
    add({ id: 'ub2', name: '2026-10-07T10000000Z', mimeType: FOLDER, parents: ['root'], isAppAuthorized: false });
    add({ id: 'uf2', name: 'x.db', mimeType: BIN, parents: ['ub2'] });
    const res = await deleteUploadedBackups(auth([DRIVE_FULL]));
    expect(res).toEqual({ status: 'deleted', deleted: 3, foldersKept: 2, problems: [] });
    for (const id of ['inRoot', 'inOdd', 'inNested', 'elsewhere', 'uf2']) {
      expect(drive.has(id), `${id} was deleted`).toBe(true);
    }
  });

  it('finds lynox\'s backups under a lynox-backups folder lynox did not make, and leaves the rest of it', async () => {
    // The root is not checked. Backup folders lynox created are lynox's wherever they sit,
    // and a check on the ROOT would report `none` over them.
    add({ id: 'userRoot', name: 'lynox-backups', mimeType: FOLDER, parents: ['my-drive'], isAppAuthorized: false });
    add({ id: 'ub', name: '2026-10-08T19301234Z', mimeType: FOLDER, parents: ['userRoot'] });
    add({ id: 'uf', name: 'history.db.enc', mimeType: BIN, parents: ['ub'] });
    add({ id: 'mine', name: 'my-notes.txt', mimeType: 'text/plain', parents: ['userRoot'], isAppAuthorized: false });
    add({ id: 'sharedRoot', name: 'lynox-backups', mimeType: FOLDER, parents: ['shared'], ownedByMe: false, isAppAuthorized: false });
    add({ id: 'sb', name: '2026-10-08T19301299Z', mimeType: FOLDER, parents: ['sharedRoot'] });
    add({ id: 'sf', name: 'history.db.enc', mimeType: BIN, parents: ['sb'] });
    add({ id: 'theirs', name: 'theirs.db', mimeType: BIN, parents: ['sb'], isAppAuthorized: false });
    const res = await deleteUploadedBackups(auth([DRIVE_FULL]));
    expect(res).toEqual({ status: 'deleted', deleted: 2, foldersKept: 4, problems: [] });
    expect(drive.has('uf')).toBe(false);
    expect(drive.has('sf')).toBe(false);
    expect(drive.has('mine')).toBe(true);
    expect(drive.has('theirs')).toBe(true);
  });

  it('leaves a file lynox created for someone else, even inside a backup folder', async () => {
    // The managed client is ONE OAuth app for every tenant, so another tenant's backup
    // passes `isAppAuthorized`. Only ownership tells it apart.
    seedOneBackup();
    add({ id: 'other', name: 'history.db.enc', mimeType: BIN, parents: ['b1'], ownedByMe: false });
    const res = await deleteUploadedBackups(auth([DRIVE_FULL]));
    expect(res).toEqual({ status: 'deleted', deleted: 3, foldersKept: 2, problems: [] });
    expect(drive.has('other')).toBe(true);
  });

  it('a listing without ownedByMe is degraded, not read as "not mine"', async () => {
    seedOneBackup();
    drive.get('h')!.ownedByMe = null;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Google did not say whether lynox-backups/2026-10-08T19301234Z/history.db.enc is yours; left in place']);
    expect(drive.has('h')).toBe(true);
  });

  it('follows every listing page', async () => {
    seedOneBackup();
    for (let i = 0; i < 5; i++) add({ id: `extra${String(i)}`, name: `f${String(i)}`, mimeType: BIN, parents: ['b1'] });
    pageSize = 2;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('deleted');
    expect(res.deleted).toBe(8);
    expect([...drive.keys()].filter(k => k.startsWith('extra'))).toEqual([]);
  });

  it('reports none when there is nothing, and unchecked without any Drive scope', async () => {
    expect(await deleteUploadedBackups(auth())).toEqual({ status: 'none', deleted: 0, foldersKept: 0, problems: [] });
    seedOneBackup();
    const res = await deleteUploadedBackups(auth([]));
    expect(res.status).toBe('unchecked');
    expect(mockGoogleFetch).toHaveBeenCalledTimes(1);
    expect(drive.has('h')).toBe(true);
  });

  it('works with the full drive scope alone', async () => {
    seedOneBackup();
    const res = await deleteUploadedBackups(auth([DRIVE_FULL]));
    expect(res.status).toBe('deleted');
    expect(drive.has('h')).toBe(false);
    expect(drive.has('copy')).toBe(true);
  });
});

describe('deleteUploadedBackups — a copy that may remain is never reported as gone', () => {
  it('a root listing that fails is degraded, not none', async () => {
    seedOneBackup();
    failList = q => q.startsWith('name =') ? 500 : null;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Could not list the lynox-backups folders: Google answered 500']);
    expect(drive.has('h')).toBe(true);
  });

  it('a backup folder whose listing fails is named, and the others are still emptied', async () => {
    seedOneBackup();
    add({ id: 'b2', name: '2026-10-09T08000000Z', mimeType: FOLDER, parents: ['root'] });
    add({ id: 'y', name: 'manifest.json', mimeType: 'application/json', parents: ['b2'] });
    failList = q => q === "'b1' in parents" ? 503 : null;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Could not list the folder lynox-backups/2026-10-08T19301234Z: Google answered 503']);
    expect(res.deleted).toBe(1);
    expect(drive.has('y')).toBe(false);
  });

  it('a listing that answers 200 with something other than JSON is named', async () => {
    seedOneBackup();
    badJson = q => q === "'b1' in parents";
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/^Could not read the listing of the folder lynox-backups\/2026-10-08T19301234Z: /);
  });

  it('a refused delete is named; one already gone counts as deleted', async () => {
    seedOneBackup();
    failDelete = id => id === 'h' ? 403 : id === 'm' ? 404 : null;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Could not delete lynox-backups/2026-10-08T19301234Z/history.db.enc: Google answered 403']);
    expect(res.deleted).toBe(2);
  });

  it('a transport error is named rather than swallowed', async () => {
    seedOneBackup();
    mockGoogleFetch.mockImplementationOnce(async () => { throw new Error('network_policy=deny-all'); });
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Could not list the lynox-backups folders: network_policy=deny-all']);
  });

  it('a listing without isAppAuthorized is degraded, not read as "not ours"', async () => {
    seedOneBackup();
    delete drive.get('h')!.isAppAuthorized;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Google did not say whether lynox-backups/2026-10-08T19301234Z/history.db.enc was created by lynox; left in place']);
    expect(drive.has('h')).toBe(true);
  });

  it('an upload in flight at the start or at the end makes it degraded', async () => {
    seedOneBackup();
    const atStart = await deleteUploadedBackups(auth(), () => true);
    expect(atStart.status).toBe('degraded');
    expect(atStart.problems).toEqual(['A backup was being uploaded when the deletion started; files it uploads may remain.']);

    seedOneBackup();
    let n = 0;
    const atEnd = await deleteUploadedBackups(auth(), () => n++ > 0);
    expect(atEnd.status).toBe('degraded');
    expect(atEnd.problems).toEqual(['A backup was being uploaded when the deletion finished; files it uploaded may remain.']);
  });

  it('stops at the deadline and says what is left', async () => {
    seedOneBackup();
    let t = 0;
    // Each clock read advances a minute, so the two-minute deadline falls inside the walk.
    const res = await deleteUploadedBackups(auth(), () => false, () => (t++) * 60_000);
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Stopped after 120 s; backup files not reached by then remain.']);
    expect(drive.has('h') || drive.has('m') || drive.has('n')).toBe(true);
  });

  it('stops a listing that never ends and says so', async () => {
    seedOneBackup();
    for (let i = 0; i < 501; i++) add({ id: `p${String(i)}`, name: `f${String(i)}`, mimeType: BIN, parents: ['b1'] });
    pageSize = 1;
    const res = await deleteUploadedBackups(auth());
    expect(res.status).toBe('degraded');
    expect(res.problems).toEqual(['Stopped listing the folder lynox-backups/2026-10-08T19301234Z after 500 pages']);
    expect(drive.has('h')).toBe(true);
  });
});
