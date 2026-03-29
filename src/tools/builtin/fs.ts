import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, join, isAbsolute } from 'node:path';
import type { ToolEntry } from '../../types/index.js';
import { isWorkspaceActive, validatePath } from '../../core/workspace.js';
import { getLynoxDir } from '../../core/config.js';

const MAX_WRITE_BYTES_PER_SESSION = 100 * 1024 * 1024; // 100MB
let sessionWriteBytes = 0;

/** Reset the session write byte counter (for testing). */
export function resetWriteByteCounter(): void {
  sessionWriteBytes = 0;
}

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
          if (!realTarget.startsWith(parentDir)) {
            throw new Error(`Blocked: that file link points outside the allowed directory. This is a security restriction.`);
          }
        }
        filePath = resolved;
      }
      return readFileSync(filePath, 'utf-8');
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
  handler: async (input: WriteFileInput): Promise<string> => {
    try {
      const contentBytes = Buffer.byteLength(input.content, 'utf-8');
      if (sessionWriteBytes + contentBytes > MAX_WRITE_BYTES_PER_SESSION) {
        throw new Error(`Session write limit (${MAX_WRITE_BYTES_PER_SESSION} bytes) exceeded.`);
      }
      // Relative paths → ~/.lynox/files/ (not process.cwd()) when no workspace is set
      const resolved = (!isAbsolute(input.path) && !isWorkspaceActive())
        ? resolve(join(getLynoxDir(), 'files'), input.path)
        : resolve(input.path);
      let realPath: string;
      if (isWorkspaceActive()) {
        realPath = validatePath(resolved, 'write');
      } else {
        // Reject symlinks that escape their parent directory (path traversal via symlink)
        if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
          const realTarget = realpathSync(resolved);
          const parentDir = realpathSync(dirname(resolved));
          if (!realTarget.startsWith(parentDir)) {
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
      sessionWriteBytes += contentBytes;
      return `Written to ${realPath}`;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`write_file: ${cause.message}`, { cause });
    }
  },
};
