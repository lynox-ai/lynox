import { createHash, type Hash } from 'node:crypto';
import { fstatSync, readSync, writeSync } from 'node:fs';

/**
 * A minimal POSIX tar writer (ustar headers, with a pax extended header where ustar cannot hold
 * the value), writing synchronously to an open file descriptor. Built for the workspace export:
 * regular files only, no links, no devices, no ownership.
 *
 * Names: an entry name is a RELATIVE path of `/`-separated components. An absolute name (its first
 * component is empty), an empty component, `.` or `..` is refused, so an extracting tool cannot be
 * steered outside its target directory by anything this writer produced. `\` is an ordinary
 * character on Linux but a separator to a Windows extractor, so a `.` or `..` between backslashes
 * is refused too. A name that ustar cannot carry faithfully (longer
 * than its field, outside printable ASCII, or holding a control character) goes into the pax
 * `path` record; the ustar field then gets a placeholder of printable ASCII only, so a reader
 * that ignores pax never sees a raw control character.
 */

const BLOCK = 512;
/** The largest value the 11 octal digits of a ustar size or mtime field hold. */
export const USTAR_MAX_SIZE = 0o77777777777;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

export class TarNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarNameError';
  }
}

/** Why `name` is not a plain relative entry name, or `null` when it is. */
export function tarNameProblem(name: string): string | null {
  if (name === '') return 'empty entry name';
  if (name.includes('\0')) return 'entry name contains NUL';
  for (const part of name.split('/')) {
    // An absolute name fails here too: its first component is empty.
    if (part === '') return `empty component in ${JSON.stringify(name)}`;
    for (const sub of part.split('\\')) {
      // Only dots and spaces: Windows strips trailing dots and spaces, so `...` or `.. ` can end as `..`.
      if (sub !== '' && /^[. ]+$/.test(sub)) return `component ${JSON.stringify(sub)} refused in ${JSON.stringify(name)}`;
    }
  }
  return null;
}

/** Refuse a name that is not a plain relative path. Returns it unchanged otherwise. */
export function checkTarName(name: string): string {
  const problem = tarNameProblem(name);
  if (problem !== null) throw new TarNameError(problem);
  return name;
}

/** Whether ustar's name field can carry `name` byte for byte: printable ASCII, at most 100 bytes. */
export function fitsUstarName(name: string): boolean {
  return Buffer.byteLength(name, 'utf8') <= 100 && /^[\x20-\x7e]*$/.test(name);
}

/** A printable-ASCII stand-in for the ustar name field when the real name lives in pax. */
function placeholderName(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_');
  return safe.length <= 100 ? safe : `${safe.slice(0, 60)}~${createHash('sha256').update(name).digest('hex').slice(0, 39)}`;
}

/** One pax record: "<len> <key>=<value>\n", where <len> counts the whole record in bytes. */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf8');
  // The length counts its own digits, so adding them can carry it over a power of ten: settle.
  let len = bodyLen + 1;
  while (len !== bodyLen + String(len).length) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number, type: '0' | 'x'): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(0o644, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(Math.min(size, USTAR_MAX_SIZE), 12), 124, 12, 'ascii');
  buf.write(octal(Math.min(USTAR_MAX_SIZE, Math.max(0, Math.floor(mtime))), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return buf;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

export interface TarFileResult {
  /** sha256 of the bytes written for this entry. */
  readonly sha256: string;
  /**
   * False when the file changed while it was read: it ended before `size` bytes (the rest is
   * zeros), or its size or modification time differ afterwards (it grew, or was rewritten).
   */
  readonly unchanged: boolean;
}

/** Yield to the event loop, so a long copy does not stall every other request. */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Writes entries to `fd` in order; `finish()` writes the two end blocks. */
export class TarWriter {
  private finished = false;

  constructor(private readonly fd: number) {}

  private write(buf: Buffer): void {
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
  }

  private writeHeaders(name: string, size: number, mtime: number): void {
    checkTarName(name);
    const records: Buffer[] = [];
    if (!fitsUstarName(name)) records.push(paxRecord('path', name));
    if (size > USTAR_MAX_SIZE) records.push(paxRecord('size', String(size)));
    if (records.length > 0) {
      const pax = Buffer.concat(records);
      this.write(header(placeholderName(`PaxHeader/${name}`), pax.length, mtime, 'x'));
      this.write(pax);
      this.write(padding(pax.length));
    }
    this.write(header(fitsUstarName(name) ? name : placeholderName(name), size, mtime, '0'));
  }

  /**
   * Add a regular file of `size` bytes read from `srcFd`, yielding to the event loop between
   * chunks. A source that ends early (shrunk while read) is padded with zeros so the archive stays
   * well-formed; that, and a file whose size or mtime moved while it was read, is reported.
   */
  async addFile(name: string, srcFd: number, size: number, mtime: number): Promise<TarFileResult> {
    if (this.finished) throw new Error('tar already finished');
    this.writeHeaders(name, size, mtime);
    const before = fstatSync(srcFd);
    const hash: Hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let done = 0;
    while (done < size) {
      const want = Math.min(chunk.length, size - done);
      const n = readSync(srcFd, chunk, 0, want, null);
      if (n === 0) break;
      const part = chunk.subarray(0, n);
      hash.update(part);
      this.write(part);
      done += n;
      await turn();
    }
    const short = done < size;
    if (short) {
      const zeros = Buffer.alloc(size - done);
      hash.update(zeros);
      this.write(zeros);
    }
    this.write(padding(size));
    const after = fstatSync(srcFd);
    const moved = after.size !== size || after.mtimeMs !== before.mtimeMs || before.size !== size;
    return { sha256: hash.digest('hex'), unchanged: !short && !moved };
  }

  /** Add a regular file whose content is `data`. */
  addBuffer(name: string, data: Buffer, mtime: number): void {
    if (this.finished) throw new Error('tar already finished');
    this.writeHeaders(name, data.length, mtime);
    this.write(data);
    this.write(padding(data.length));
  }

  finish(): void {
    if (this.finished) return;
    this.write(ZERO_BLOCK);
    this.write(ZERO_BLOCK);
    this.finished = true;
  }
}
