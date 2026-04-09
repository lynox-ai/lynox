/**
 * Benchmark: Memory system (flat-file I/O)
 *
 * Measures load, append, save, delete, and render operations
 * on the file-based memory system.
 *
 * Note: Memory constructor instantiates Anthropic client but benchmarks
 * never call extraction (maybeUpdate), so no API calls are made.
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { Memory } from '../../src/core/memory.js';
import { createBenchDir, generateText } from './setup.js';

let memory: Memory;
let cleanup: () => void;

beforeAll(() => {
  const tmp = createBenchDir('lynox-bench-mem-');
  cleanup = tmp.cleanup;
  // API key is fake — no extraction calls happen during benchmarks
  memory = new Memory(tmp.path, 'sk-ant-bench-fake-key', undefined, 'bench-context');
});

afterAll(() => {
  cleanup();
});

describe('Memory — save + load', () => {
  bench('save short entry', async () => {
    await memory.save('knowledge', 'Project uses PostgreSQL 16+ for JSONB queries.');
  });

  bench('save medium entry (1KB)', async () => {
    await memory.save('knowledge', generateText(1000));
  });

  bench('load from cache (hit)', async () => {
    await memory.save('knowledge', 'cached content');
    await memory.load('knowledge');
  });

  bench('load from disk (miss)', async () => {
    await memory.save('methods', 'content on disk');
    await memory.load('methods');
  });
});

describe('Memory — append', () => {
  bench('append single entry', async () => {
    await memory.append('knowledge', `Entry ${Date.now()}: New fact learned.`);
  });

  bench('append to existing (10 entries)', async () => {
    for (let i = 0; i < 10; i++) {
      await memory.append('project-state', `[2026-03-${String(i + 1).padStart(2, '0')}] State update ${i}`);
    }
    await memory.append('project-state', `[2026-03-24] Latest state update`);
  });
});

describe('Memory — delete', () => {
  bench('delete by pattern', async () => {
    await memory.save('knowledge', 'Keep this line\nDelete this: PostgreSQL\nKeep this too');
    await memory.delete('knowledge', 'PostgreSQL');
  });
});

describe('Memory — render', () => {
  bench('render with 5 namespaces populated', async () => {
    await memory.save('knowledge', generateText(500));
    await memory.save('methods', generateText(300));
    await memory.save('project-state', generateText(400));
    await memory.save('learnings', generateText(200));
    memory.render();
  });
});

describe('Memory — loadAll', () => {
  bench('loadAll (4 namespaces)', async () => {
    await memory.save('knowledge', generateText(500));
    await memory.save('methods', generateText(300));
    await memory.save('project-state', generateText(400));
    await memory.save('learnings', generateText(200));
    await memory.loadAll();
  });
});
