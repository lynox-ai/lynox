import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import type { ToolEntry } from '../../types/index.js';
import { isWorkspaceActive, validatePath } from '../../core/workspace.js';
import { getErrorMessage } from '../../core/utils.js';
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

export const batchFilesTool: ToolEntry<BatchFilesInput> = {
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
    // Resolve symlinks on the directory itself to prevent traversal via symlinked root
    const dir = realpathSync(resolve(input.directory));
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
