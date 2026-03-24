import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgent } from '../../types/index.js';
import { createToolContext } from '../../core/tool-context.js';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import { homedir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Minimal mock agent
const toolContext = createToolContext({});
const mockAgent: IAgent = {
  name: 'test',
  currentRunId: 'test-run',
  toolContext,
} as unknown as IAgent;

describe('playbook tools', () => {
  let tempDir: string;
  let listPlaybooksTool: typeof import('./playbook.js').listPlaybooksTool;
  let suggestPlaybookTool: typeof import('./playbook.js').suggestPlaybookTool;
  let extractPlaybookTool: typeof import('./playbook.js').extractPlaybookTool;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nodyn-playbook-tools-test-'));
    vi.mocked(homedir).mockReturnValue(tempDir);

    vi.resetModules();
    const mod = await import('./playbook.js');
    listPlaybooksTool = mod.listPlaybooksTool;
    suggestPlaybookTool = mod.suggestPlaybookTool;
    extractPlaybookTool = mod.extractPlaybookTool;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // === list_playbooks ===

  it('list_playbooks returns all built-in playbooks', async () => {
    const result = await listPlaybooksTool.handler({} as never, mockAgent);
    expect(result).toContain('research');
    expect(result).toContain('evaluation');
    expect(result).toContain('diagnosis');
    expect(result).toContain('synthesis');
    expect(result).toContain('assessment');
    expect(result).toContain('creation');
    expect(result).toContain('planning');
    expect(result).toContain('Available Playbooks');
  });

  // === suggest_playbook ===

  it('suggest_playbook returns playbook details with phases', async () => {
    const result = await suggestPlaybookTool.handler(
      { task_description: 'I need to research a topic deeply' },
      mockAgent,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.task).toBe('I need to research a topic deeply');
    expect(parsed.available_playbooks).toBeDefined();
    const playbooks = parsed.available_playbooks as Array<Record<string, unknown>>;
    expect(playbooks.length).toBeGreaterThanOrEqual(7);
    // Check one playbook has phases
    const dr = playbooks.find(p => p.id === 'research');
    expect(dr).toBeDefined();
    expect((dr!.phases as unknown[]).length).toBe(4);
    expect(dr!.applicableWhen).toBeTruthy();
  });

  // === extract_playbook ===

  it('extract_playbook returns error for non-existent pipeline', async () => {
    const result = await extractPlaybookTool.handler(
      { pipeline_id: 'nonexistent', name: 'test' },
      mockAgent,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toContain('not found');
  });

  it('extract_playbook converts pipeline to playbook', async () => {
    // Set up a pipeline in the store
    vi.resetModules();
    const pipelineMod = await import('./pipeline.js');
    const playbookMod = await import('./playbook.js');

    pipelineMod.storePipeline('test-pipe', {
      id: 'test-pipe',
      name: 'Test Pipeline',
      goal: 'Test goal',
      steps: [
        { id: 'research', task: 'Research the topic using web search' },
        { id: 'analyze', task: 'Analyze and compare findings', input_from: ['research'] },
        { id: 'write-report', task: 'Write a report with recommendations', input_from: ['analyze'] },
      ],
      reasoning: 'Test',
      estimatedCost: 0.5,
      createdAt: new Date().toISOString(),
      executed: true,
    });

    const result = await playbookMod.extractPlaybookTool.handler(
      { pipeline_id: 'test-pipe', name: 'Test Playbook', description: 'A test playbook' },
      mockAgent,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.error).toBeUndefined();
    expect(parsed.playbook_id).toBe('test-playbook');
    expect(parsed.phases).toBe(3);
    expect(parsed.phase_summary).toContain('researcher');
  });
});
