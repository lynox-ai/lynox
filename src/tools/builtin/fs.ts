import { openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, join, isAbsolute, relative } from 'node:path';
import type { ToolEntry, IAgent } from '../../types/index.js';
import { isWorkspaceActive, validatePath } from '../../core/workspace.js';
import { getLynoxDir } from '../../core/config.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

/**
 * Per-Session byte budget for write_file. Previously enforced via the
 * module-level `sessionWriteBytes`; that masqueraded as per-session but
 * actually accumulated for the lifetime of the process (no reset between
 * Sessions outside the test-only `resetWriteByteCounter` helper). Now
 * charged against `agent.sessionCounters.writeBytes`, which the owning
 * Session allocates fresh on construction and the spawn-agent path
 * shares with sub-agents.
 */
const MAX_WRITE_BYTES_PER_SESSION = 100 * 1024 * 1024; // 100MB

// Soft-cap: truncate + nudge toward spawn_agent collector. Hard-cap: refuse.
// Without these one multi-MB read could consume the main agent's context.
const READ_FILE_SOFT_CAP_BYTES = 256 * 1024;
const READ_FILE_HARD_CAP_BYTES = 5 * 1024 * 1024;

interface ReadFileInput {
  path: string;
}

interface WriteFileInput {
  path: string;
  content: string;
}

interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}

/** Resolve + boundary-validate a writable path with the same rules as
 *  write_file: validatePath when workspace isolation is active, else
 *  workspace-relative + escape-symlink rejection. */
function resolveWritablePath(rawPath: string): string {
  if (isWorkspaceActive()) {
    return validatePath(resolve(rawPath), 'write');
  }
  // CLI/headless (no isolation): artifacts live at ~/.lynox/artifacts/<id>.html,
  // NOT under the workspace dir. Honour an absolute path inside the artifacts
  // root as-is so the advertised "read_file the artifact path, then edit_file
  // it" flow works here too instead of basename-stripping into ~/.lynox/workspace/.
  const artRootRaw = resolve(join(getLynoxDir(), 'artifacts'));
  const artRoot = existsSync(artRootRaw) ? realpathSync(artRootRaw) : artRootRaw;
  const absRaw = resolve(rawPath);
  // Resolve symlinks on the FINAL path before the containment check so a
  // symlink planted inside the artifacts dir (evil.html → /etc/passwd) can't
  // redirect the write outside it. A target that escapes artRoot fails the
  // relative()-check and falls through to the workspace-relative branch below.
  const realAbs = existsSync(absRaw)
    ? realpathSync(absRaw)
    : existsSync(dirname(absRaw))
      ? join(realpathSync(dirname(absRaw)), basename(absRaw))
      : absRaw;
  const relToArt = relative(artRoot, realAbs);
  if (relToArt !== '' && !relToArt.startsWith('..') && !isAbsolute(relToArt)) {
    return realAbs;
  }
  const name = isAbsolute(rawPath) ? basename(rawPath) : rawPath;
  const resolved = resolve(join(getLynoxDir(), 'workspace'), name);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    const realTarget = realpathSync(resolved);
    const parentDir = realpathSync(dirname(resolved));
    if (!realTarget.startsWith(parentDir + '/') && realTarget !== parentDir) {
      throw new Error(`Blocked: that file link points outside the allowed directory. This is a security restriction.`);
    }
  }
  return existsSync(resolved)
    ? realpathSync(resolved)
    : existsSync(dirname(resolved))
      ? join(realpathSync(dirname(resolved)), basename(resolved))
      : resolved;
}

export const readFileTool: ToolEntry<ReadFileInput> = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
  handler: async (input: ReadFileInput): Promise<string> => {
    try {
      let filePath: string;
      if (isWorkspaceActive()) {
        filePath = validatePath(input.path, 'read');
      } else {
        const resolved = resolve(input.path);
        // Reject symlinks that escape their parent directory (path traversal via symlink)
        if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
          const realTarget = realpathSync(resolved);
          const parentDir = realpathSync(dirname(resolved));
          if (!realTarget.startsWith(parentDir + '/') && realTarget !== parentDir) {
            throw new Error(`Blocked: that file link points outside the allowed directory. This is a security restriction.`);
          }
        }
        filePath = resolved;
      }
      // Wrap file content in untrusted-data envelope. The content originates
      // outside the agent's trust boundary (user-provided file, attacker-
      // controllable in shared/managed workspaces) so any prompt-injection
      // payload it carries must be presented to the LLM as data, not framing.
      // See H-001 (OVERNIGHT-PUNCH-LIST-2026-05-25) — read_file used to be
      // exempt from the wrap via the INTERNAL_TOOLS allowlist in agent.ts.
      //
      // Open-once + fstat: same fd for stat and read closes the TOCTOU
      // window where an attacker could swap the file between two separate
      // path-based calls.
      const fd = openSync(filePath, 'r');
      let content: string;
      try {
        const stats = fstatSync(fd);
        if (stats.size > READ_FILE_HARD_CAP_BYTES) {
          const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
          const hardMb = READ_FILE_HARD_CAP_BYTES / 1024 / 1024;
          throw new Error(
            `file too large (${sizeMb} MB exceeds ${hardMb} MB hard cap). ` +
            `Use \`spawn_agent\` with role='collector' to summarize this file, ` +
            `or read specific sections via shell tools (head, tail, sed).`,
          );
        }
        const oversized = stats.size > READ_FILE_SOFT_CAP_BYTES;
        const readLen = oversized ? READ_FILE_SOFT_CAP_BYTES : stats.size;
        const buf = Buffer.alloc(readLen);
        if (readLen > 0) readSync(fd, buf, 0, readLen, 0);
        // Slicing utf-8 mid-codepoint produces a trailing U+FFFD; strip it
        // so the visible payload ends cleanly.
        content = buf.toString('utf-8').replace(/�+$/, '');
        if (oversized) {
          const sizeKb = (stats.size / 1024).toFixed(1);
          const capKb = READ_FILE_SOFT_CAP_BYTES / 1024;
          content =
            `${content}\n\n[truncated: file is ${sizeKb} KB, only first ${capKb} KB shown. ` +
            `Spawn a collector agent (\`spawn_agent\` role='collector') to summarize the full file, ` +
            `or read specific sections via shell tools.]`;
        }
      } finally {
        closeSync(fd);
      }
      return wrapUntrustedData(content, `file:${basename(filePath)}`);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`read_file: ${cause.message}`, { cause });
    }
  },
};

export const writeFileTool: ToolEntry<WriteFileInput> = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file, creating directories as needed.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  handler: async (input: WriteFileInput, agent: IAgent): Promise<string> => {
    try {
      const contentBytes = Buffer.byteLength(input.content, 'utf-8');
      if (agent.sessionCounters.writeBytes + contentBytes > MAX_WRITE_BYTES_PER_SESSION) {
        throw new Error(`Session write limit (${MAX_WRITE_BYTES_PER_SESSION} bytes) exceeded.`);
      }
      // Without active workspace: ALL paths → ~/.lynox/workspace/ (strip leading /)
      // With active workspace: resolve normally (validatePath enforces boundaries)
      let resolved: string;
      if (isWorkspaceActive()) {
        resolved = resolve(input.path);
      } else {
        const name = isAbsolute(input.path) ? basename(input.path) : input.path;
        resolved = resolve(join(getLynoxDir(), 'workspace'), name);
      }
      let realPath: string;
      if (isWorkspaceActive()) {
        realPath = validatePath(resolved, 'write');
      } else {
        // Reject symlinks that escape their parent directory (path traversal via symlink)
        if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
          const realTarget = realpathSync(resolved);
          const parentDir = realpathSync(dirname(resolved));
          if (!realTarget.startsWith(parentDir + '/') && realTarget !== parentDir) {
            throw new Error(`Blocked: that file link points outside the allowed directory. This is a security restriction.`);
          }
        }
        realPath = existsSync(resolved)
          ? realpathSync(resolved)
          : existsSync(dirname(resolved))
            ? join(realpathSync(dirname(resolved)), basename(resolved))
            : resolved;
      }
      mkdirSync(dirname(realPath), { recursive: true });
      writeFileSync(realPath, input.content, 'utf-8');
      agent.sessionCounters.writeBytes += contentBytes;
      return `Written to ${realPath}`;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`write_file: ${cause.message}`, { cause });
    }
  },
};

export const editFileTool: ToolEntry<EditFileInput> = {
  definition: {
    name: 'edit_file',
    description:
      'Make a targeted edit to an existing file by replacing an exact string — far cheaper than rewriting the whole file with write_file. ' +
      '`old_string` must match the file exactly (including whitespace) and be unique unless `replace_all` is true. ' +
      'Prefer this for revising artifacts (read_file the path returned by artifact_save first), long documents, configs, or code.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'Exact text to find. Must be unique in the file unless replace_all is set.' },
        new_string: { type: 'string', description: 'Text to replace it with' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default: false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  handler: async (input: EditFileInput, agent: IAgent): Promise<string> => {
    try {
      const realPath = resolveWritablePath(input.path);
      if (!existsSync(realPath)) {
        throw new Error(`file does not exist: ${realPath}. Use write_file to create it.`);
      }
      if (input.old_string === input.new_string) {
        throw new Error('old_string and new_string are identical — nothing to change.');
      }
      const original = readFileSync(realPath, 'utf-8');
      const segments = original.split(input.old_string);
      const matches = segments.length - 1;
      if (matches === 0) {
        throw new Error('old_string not found. Read the file first and copy the exact text, including whitespace.');
      }
      const replaceAll = input.replace_all === true;
      if (matches > 1 && !replaceAll) {
        throw new Error(`old_string matches ${matches} times — add surrounding context to make it unique, or set replace_all: true.`);
      }
      const updated = segments.join(input.new_string);

      // Charge only the net growth against the write budget (an edit usually
      // shrinks or barely grows the file — unlike a full write_file rewrite).
      const delta = Math.max(0, Buffer.byteLength(updated, 'utf-8') - Buffer.byteLength(original, 'utf-8'));
      if (agent.sessionCounters.writeBytes + delta > MAX_WRITE_BYTES_PER_SESSION) {
        throw new Error(`Session write limit (${MAX_WRITE_BYTES_PER_SESSION} bytes) exceeded.`);
      }
      writeFileSync(realPath, updated, 'utf-8');
      agent.sessionCounters.writeBytes += delta;
      const n = replaceAll ? matches : 1;
      return `Edited ${realPath} (${n} replacement${n === 1 ? '' : 's'})`;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`edit_file: ${cause.message}`, { cause });
    }
  },
};
