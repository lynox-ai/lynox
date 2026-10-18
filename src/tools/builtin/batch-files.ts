import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, realpathSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve, posix } from 'node:path';
import type { ToolEntry } from '../../types/index.js';
import { isWorkspaceActive, validatePath, isPathWithin } from '../../core/workspace.js';
import { processUmask, toWorkspaceRel } from '../../core/workspace-rel.js';
import { listDir, mkdirAt, openRead, renameAt, type WorkspaceAnchor } from '../../core/workspace-fd.js';
import { anchoredError, isInArtifactsRoot, reachWorkspace, refuseEvictionPlaceholder, writeInPlace } from './fs.js';
import { getErrorMessage } from '../../core/utils.js';
import { containsEvictionMarker } from '../../core/artifact-eviction.js';
import { MAX_BUFFER_BYTES } from '../../core/constants.js';

const MAX_FIND_DEPTH = 10;
const MAX_FIND_FILES = 10_000;

interface BatchFilesInput {
  pattern: string;
  directory: string;
  operation: 'rename' | 'move' | 'transform';
  rename_pattern?: string | undefined;
  destination?: string | undefined;
  find?: string | undefined;
  replace?: string | undefined;
}

function globMatch(pattern: string, str: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(str);
}

function findFiles(dir: string, pattern: string, depth = 0, count = { value: 0 }): string[] {
  if (depth > MAX_FIND_DEPTH || count.value >= MAX_FIND_FILES) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (count.value >= MAX_FIND_FILES) break;
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, pattern, depth + 1, count));
    } else if (entry.isFile() && globMatch(pattern, entry.name) && count.value < MAX_FIND_FILES) {
      results.push(fullPath);
      count.value++;
    }
  }
  return results;
}

/** As `findFiles`, below `rel` in the context workspace, one directory at a time through its open directory. */
function findFilesAt(anchor: WorkspaceAnchor, rel: string, pattern: string, depth = 0, count = { value: 0 }): string[] {
  if (depth > MAX_FIND_DEPTH || count.value >= MAX_FIND_FILES) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = listDir(anchor, rel);
  } catch (err) {
    // The directory asked for must be reachable (a link there is refused, not reported as empty);
    // one below it that is not is left out, as by name.
    if (depth === 0) throw err;
    return results;
  }
  for (const entry of entries) {
    if (count.value >= MAX_FIND_FILES) break;
    // A name that is not valid UTF-8 cannot be addressed again by its decoded text.
    if (!entry.exactName) continue;
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.type === 'dir') {
      results.push(...findFilesAt(anchor, childRel, pattern, depth + 1, count));
    } else if (entry.type === 'file' && globMatch(pattern, entry.name) && count.value < MAX_FIND_FILES) {
      results.push(childRel);
      count.value++;
    }
  }
  return results;
}

/**
 * Whether a path outside the workspace by name would still land in it: by its spelling, or
 * through a link on the way (the closest existing ancestor, followed).
 */
function landsInWorkspace(path: string, ws: string): boolean {
  if (toWorkspaceRel(path, ws).kind === 'inside') return true;
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (!existsSync(probe)) return false;
  const wsReal = existsSync(ws) ? realpathSync(ws) : ws;
  const real = realpathSync(probe);
  return isPathWithin(real, ws) || isPathWithin(real, wsReal);
}

/**
 * The check the file tools make (`refuseEvictionPlaceholder`), for a file batch_files would leave
 * in the artifacts directory by moving or renaming it there: its whole content is what lands, so
 * the content is read, and only when it does land there. A file too large to read is refused
 * rather than moved in unchecked.
 *
 * Only the by-path branch below needs it. The workspace branch (`batchAnchored`) never leaves the
 * workspace, and no workspace holds the artifacts directory: the root is `<data>/workspace` or a
 * directory outside the data directory, and one inside or holding it is refused
 * (`workspaceBase`, `unsafeRoot`).
 */
function refusePlaceholderLanding(landing: string, file: string): void {
  if (!isInArtifactsRoot(landing)) return;
  if (statSync(file).size > MAX_BUFFER_BYTES) {
    throw new Error('it is too large to check for the engine\'s placeholder, and batch_files does not move such a file into the artifacts directory');
  }
  refuseEvictionPlaceholder(readFileSync(file, 'utf-8'), landing);
}

/** Where a path that may not exist yet lands, its directory's links resolved. */
function landingPath(path: string): string {
  const dir = dirname(path);
  return join(existsSync(dir) ? realpathSync(dir) : dir, basename(path));
}

/** A workspace path below the context workspace, or null when `rel` leaves it. */
function insideRel(rel: string): string | null {
  const normal = posix.normalize(rel);
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.startsWith('/')) return null;
  return normal.replace(/\/$/, '');
}

/**
 * With isolation and `directory` in the context workspace: everything through the workspace's
 * open directory. A link on the way is refused, never followed; a move or rename never leaves
 * the workspace (a destination outside it is refused).
 */
function batchAnchored(input: BatchFilesInput, anchor: WorkspaceAnchor, ws: string, dirRel: string): string {
  const shown = (rel: string): string => (rel === '' ? ws : `${ws}/${rel}`);
  let files: string[];
  try {
    files = findFilesAt(anchor, dirRel, input.pattern);
  } catch (err: unknown) {
    throw anchoredError(shown(dirRel), err);
  }
  if (files.length === 0) {
    return `No files matching "${input.pattern}" found in ${shown(dirRel)}`;
  }
  const results: string[] = [];
  switch (input.operation) {
    case 'rename': {
      if (!input.rename_pattern) return 'rename_pattern is required for rename operation';
      for (const rel of files) {
        try {
          const name = posix.basename(rel);
          const newName = input.rename_pattern.replace('$1', name.replace(/\.[^.]+$/, ''));
          const newRel = insideRel(posix.join(posix.dirname(rel), newName));
          if (newRel === null) throw new Error(`the new name ${newName} leaves the workspace`);
          renameAt(anchor, rel, newRel);
          results.push(`${name} → ${newName}`);
        } catch (err: unknown) {
          results.push(`Error renaming ${shown(rel)}: ${anchoredError(shown(rel), err).message}`);
        }
      }
      break;
    }
    case 'move': {
      if (!input.destination) return 'destination is required for move operation';
      const dest = toWorkspaceRel(resolve(input.destination), ws);
      if (dest.kind !== 'inside') {
        return `destination ${input.destination} is outside the workspace; batch_files moves files within the workspace only.`;
      }
      try {
        if (dest.rel !== '') mkdirAt(anchor, dest.rel, 0o777 & ~processUmask());
      } catch (err: unknown) {
        return `Error creating ${dest.shown}: ${anchoredError(dest.shown, err).message}`;
      }
      for (const rel of files) {
        const name = posix.basename(rel);
        const newRel = dest.rel === '' ? name : `${dest.rel}/${name}`;
        try {
          renameAt(anchor, rel, newRel);
          results.push(`${shown(rel)} → ${shown(newRel)}`);
        } catch (err: unknown) {
          results.push(`Error moving ${shown(rel)}: ${anchoredError(shown(rel), err).message}`);
        }
      }
      break;
    }
    case 'transform': {
      if (!input.find || input.replace === undefined) return 'find and replace are required for transform operation';
      for (const rel of files) {
        const target = { anchor, rel, shown: shown(rel) };
        try {
          let content: string;
          const fd = openRead(anchor, rel);
          try {
            const st = fstatSync(fd);
            // A second name may be a file outside the workspace, as for the file tools.
            if (st.nlink > 1) throw new Error('it has more than one name (a hard link); batch_files does not change such a file');
            if (st.size > MAX_BUFFER_BYTES) {
              results.push(`Skipped (too large): ${target.shown}`);
              continue;
            }
            content = readFileSync(fd, 'utf-8');
          } finally {
            closeSync(fd);
          }
          const updated = content.replaceAll(input.find, input.replace);
          if (content !== updated) {
            writeInPlace(target, updated, false);
            results.push(`Transformed: ${target.shown}`);
          } else {
            results.push(`No changes: ${target.shown}`);
          }
        } catch (err: unknown) {
          results.push(`Error transforming ${target.shown}: ${anchoredError(target.shown, err).message}`);
        }
      }
      break;
    }
  }
  return `Processed ${files.length} file(s):\n${results.join('\n')}`;
}

export const batchFilesTool: ToolEntry<BatchFilesInput> = {
  undo: 'restorable',
  definition: {
    name: 'batch_files',
    description: 'Apply changes to multiple files at once — rename, move, or find-and-replace text across files matching a pattern.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match filenames (e.g. "*.txt")' },
        directory: { type: 'string', description: 'Directory to search in' },
        operation: { type: 'string', enum: ['rename', 'move', 'transform'], description: 'Operation to perform' },
        rename_pattern: { type: 'string', description: 'For rename: new name pattern with $1 for original name' },
        destination: { type: 'string', description: 'For move: destination directory' },
        find: { type: 'string', description: 'For transform: text to find in file contents' },
        replace: { type: 'string', description: 'For transform: replacement text' },
      },
      required: ['pattern', 'directory', 'operation'],
    },
  },
  handler: async (input: BatchFilesInput): Promise<string> => {
    const base = reachWorkspace(input.directory);
    if (base !== null) {
      const mapped = toWorkspaceRel(resolve(input.directory), base.ws);
      if (mapped.kind === 'inside') return batchAnchored(input, base.anchor, base.ws, mapped.rel);
    }
    // Resolve symlinks on the directory itself to prevent traversal via symlinked root
    const dir = realpathSync(resolve(input.directory));
    if (base !== null) {
      // Outside the workspace by name; one that lands in it through a link would reach its files by name.
      if (landsInWorkspace(dir, base.ws)) {
        throw new Error(`${input.directory} reaches the workspace through a link. Name the directory by its path in the workspace (${base.ws}).`);
      }
      // A directory that holds the workspace would walk into it, and reach its files by name.
      const wsReal = existsSync(base.ws) ? realpathSync(base.ws) : base.ws;
      if (isPathWithin(base.ws, dir) || isPathWithin(wsReal, dir)) {
        throw new Error(`${input.directory} holds the workspace. Name a directory in the workspace (${base.ws}), or one beside it.`);
      }
      if (input.operation === 'move' && input.destination && landsInWorkspace(resolve(input.destination), base.ws)) {
        return `destination ${input.destination} is in the workspace, the directory is not; batch_files moves files within one of them only.`;
      }
    }
    if (isWorkspaceActive()) {
      validatePath(dir, 'write');
      if (input.operation === 'move' && input.destination) {
        validatePath(resolve(input.destination), 'write');
      }
    }
    const files = findFiles(dir, input.pattern);

    if (files.length === 0) {
      return `No files matching "${input.pattern}" found in ${dir}`;
    }

    const results: string[] = [];

    switch (input.operation) {
      case 'rename': {
        if (!input.rename_pattern) return 'rename_pattern is required for rename operation';
        for (const file of files) {
          try {
            const name = basename(file);
            const newName = input.rename_pattern.replace('$1', name.replace(/\.[^.]+$/, ''));
            const newPath = join(dirname(file), newName);
            // Confine the rename target: `rename_pattern` is agent-controlled and
            // join() collapses `../`, so an unvalidated newPath escapes the
            // workspace (`../../etc/…`) — a write-anywhere primitive. `move`
            // already validates its destination; rename must too.
            if (isWorkspaceActive()) validatePath(newPath, 'write');
            if (base !== null && landsInWorkspace(newPath, base.ws)) throw new Error(`the new name ${newName} lands in the workspace`);
            refusePlaceholderLanding(landingPath(newPath), file);
            renameSync(file, newPath);
            results.push(`${name} → ${newName}`);
          } catch (err: unknown) {
            results.push(`Error renaming ${file}: ${getErrorMessage(err)}`);
          }
        }
        break;
      }
      case 'move': {
        if (!input.destination) return 'destination is required for move operation';
        const dest = resolve(input.destination);
        mkdirSync(dest, { recursive: true });
        for (const file of files) {
          try {
            const name = basename(file);
            const newPath = join(dest, name);
            refusePlaceholderLanding(landingPath(newPath), file);
            renameSync(file, newPath);
            results.push(`${file} → ${newPath}`);
          } catch (err: unknown) {
            results.push(`Error moving ${file}: ${getErrorMessage(err)}`);
          }
        }
        break;
      }
      case 'transform': {
        if (!input.find || input.replace === undefined) return 'find and replace are required for transform operation';
        // Whether the inserted text is the placeholder does not depend on the file, so the
        // per-file path check (`refuseEvictionPlaceholder`) runs only when it is.
        const insertsPlaceholder = containsEvictionMarker(input.replace);
        for (const file of files) {
          try {
            const stat = statSync(file);
            if (stat.size > MAX_BUFFER_BYTES) {
              results.push(`Skipped (too large): ${file}`);
              continue;
            }
            const content = readFileSync(file, 'utf-8');
            const updated = content.replaceAll(input.find, input.replace);
            if (content !== updated) {
              if (insertsPlaceholder) refuseEvictionPlaceholder(input.replace, file);
              writeFileSync(file, updated, 'utf-8');
              results.push(`Transformed: ${file}`);
            } else {
              results.push(`No changes: ${file}`);
            }
          } catch (err: unknown) {
            results.push(`Error transforming ${file}: ${getErrorMessage(err)}`);
          }
        }
        break;
      }
    }

    return `Processed ${files.length} file(s):\n${results.join('\n')}`;
  },
};
