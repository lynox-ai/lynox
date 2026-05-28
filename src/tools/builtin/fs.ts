import { openSync, closeSync, fstatSync, readSync, writeFileSync, mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, join, isAbsolute } from 'node:path';
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
