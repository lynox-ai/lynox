import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendContextCostLog, CONTEXT_COST_LOG_FILE, type ContextCostLogEntry } from './context-cost-log.js';

function entry(over: Partial<ContextCostLogEntry> = {}): ContextCostLogEntry {
  return {
    ts: 1_700_000_000_000,
    thread: 'thread-1',
    model: 'claude-sonnet-4-6',
    cacheReadTokens: 1234,
    messageCount: 3,
    totalBytes: 100,
    messageTokensEstimate: 28.5,
    occupancyTokens: 5000,
    overheadTokens: 4971,
    categories: { userText: 40, assistantText: 30, toolUse: 10, toolResult: 15, image: 0, structural: 5 },
    toolResultByTool: { web_fetch: { bytes: 15, count: 1 } },
    duplicateResidentBytes: 0,
    duplicateResidentCount: 0,
    ...over,
  };
}

describe('appendContextCostLog', () => {
  let dir: string;
  const prevDataDir = process.env['LYNOX_DATA_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lynox-costlog-'));
    process.env['LYNOX_DATA_DIR'] = dir;
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per call to the data dir', async () => {
    await appendContextCostLog(entry({ thread: 'a' }));
    await appendContextCostLog(entry({ thread: 'b' }));
    const file = path.join(dir, CONTEXT_COST_LOG_FILE);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as ContextCostLogEntry;
    expect(first.thread).toBe('a');
    expect(first.occupancyTokens).toBe(5000);
    expect((JSON.parse(lines[1]!) as ContextCostLogEntry).thread).toBe('b');
  });

  it('never throws when the data dir is unwritable (best-effort)', async () => {
    // Point at a non-existent nested path so appendFile fails (ENOENT) — and the
    // writer must swallow it rather than propagate into the agent run.
    process.env['LYNOX_DATA_DIR'] = path.join(dir, 'missing', 'nope', 'deeper');
    await expect(appendContextCostLog(entry())).resolves.toBeUndefined();
  });
});
