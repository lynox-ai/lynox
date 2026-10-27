/**
 * `/proc/self/mountinfo`, read for start check (d) of the shell sidecar (PRD
 * shell-sidecar-activation D2): no mount other than the workspace anchor's may show the same
 * tree, wholly or in part.
 *
 * A line is `<id> <parent> <major>:<minor> <root> <mount point> <options> … - <fs> <source> …`.
 * `<root>` is the path inside the filesystem that the mount shows. The kernel escapes space, tab,
 * newline and backslash in it as `\040 \011 \012 \134`.
 */

export interface MountEntry {
  readonly id: number;
  readonly device: string;
  /** The root's path components, unescaped; null for a root that is not a path (skipped). */
  readonly root: readonly string[] | null;
}

/** Undo the kernel's octal escapes (`\040` and its siblings) in a mountinfo field. */
export function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Parse mountinfo. A line that does not have the fixed fields throws: the check that reads it
 * would otherwise pass on a table it could not read.
 */
export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const f = line.split(' ');
    const id = Number(f[0]);
    const device = f[2];
    const rawRoot = f[3];
    if (f.length < 5 || !Number.isInteger(id) || device === undefined || !/^\d+:\d+$/.test(device) || rawRoot === undefined) {
      throw new Error(`mountinfo line not understood: ${JSON.stringify(line)}`);
    }
    entries.push({ id, device, root: rootComponents(rawRoot) });
  }
  return entries;
}

/**
 * The root's components, or null for a root that names no path: a namespace file (`mnt:[…]`) or
 * a deleted directory (`…//deleted`, as the kernel's dentry path marks it).
 */
function rootComponents(raw: string): string[] | null {
  if (!raw.startsWith('/') || raw.endsWith('//deleted')) return null;
  return unescapeMountField(raw).split('/').filter((c) => c !== '');
}

/** Whether `a` is `b` or an ancestor of it, compared by components (never by string prefix). */
function covers(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((c, i) => c === b[i]);
}

/**
 * The other mounts that show the tree of mount `id`, wholly or in part: same device, and a root
 * equal to its root, an ancestor of it or below it. Throws if `id` is not in the table or its own
 * root is not a path: then nothing can be compared.
 */
export function otherNamesFor(entries: readonly MountEntry[], id: number): MountEntry[] {
  const own = entries.find((e) => e.id === id);
  if (own === undefined) throw new Error(`mount ${id} is not in mountinfo`);
  const ownRoot = own.root;
  if (ownRoot === null) throw new Error(`mount ${id} has a root that is not a path`);
  return entries.filter((e) => e.id !== id && e.device === own.device && e.root !== null
    && (covers(e.root, ownRoot) || covers(ownRoot, e.root)));
}
