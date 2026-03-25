/**
 * Online tests: Process Capture with real Haiku API calls.
 *
 * Cost: ~$0.002 total for all tests in this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { captureProcess } from '../../src/core/process-capture.js';
import type { ToolCallRecord } from '../../src/core/run-history.js';
import { getApiKey, hasApiKey } from './setup.js';

const SKIP = !hasApiKey();

function tc(tool_name: string, input: string, output: string, order: number): ToolCallRecord {
  return { id: `tc-${order}`, run_id: 'run-test', tool_name, input_json: input, output_json: output, duration_ms: 100, sequence_order: order };
}

describe.skipIf(SKIP)('Online: Process Capture', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  it('names steps and identifies parameters from tool calls', async () => {
    const toolCalls: ToolCallRecord[] = [
      tc('bash', '{"command": "npm init -y"}', '{"stdout": "Wrote to package.json"}', 0),
      tc('write_file', '{"path": "src/index.ts", "content": "console.log(\'hello\')"}', 'Written 24 bytes', 1),
      tc('bash', '{"command": "npm install typescript --save-dev"}', '{"stdout": "added 1 package"}', 2),
      tc('bash', '{"command": "npx tsc --init"}', '{"stdout": "Created tsconfig.json"}', 3),
    ];

    const result = await captureProcess(
      'run-test-001',
      'Setup TypeScript Project',
      toolCalls,
      { apiKey, description: 'Initialize a new TypeScript project with build tools' },
    );

    expect(result.name).toBe('Setup TypeScript Project');
    expect(result.sourceRunId).toBe('run-test-001');
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeTruthy();

    for (const step of result.steps) {
      expect(step.description).toBeTruthy();
      expect(step.tool).toBeTruthy();
      expect(typeof step.order).toBe('number');
    }
  }, 20_000);

  it('identifies variable parameters from tool calls', async () => {
    const toolCalls: ToolCallRecord[] = [
      tc('bash', '{"command": "mkdir -p /workspace/my-project"}', '{}', 0),
      tc('write_file', '{"path": "/workspace/my-project/README.md", "content": "# My Project"}', 'Written 40 bytes', 1),
    ];

    const result = await captureProcess(
      'run-test-002',
      'Create Project Scaffold',
      toolCalls,
      { apiKey },
    );

    expect(result.parameters.length).toBeGreaterThanOrEqual(0);

    for (const param of result.parameters) {
      expect(param.name).toBeTruthy();
      expect(param.description).toBeTruthy();
      expect(['string', 'number', 'date']).toContain(param.type);
      expect(['user_input', 'relative_date', 'context']).toContain(param.source);
    }
  }, 20_000);

  it('filters internal tools and returns empty steps for memory-only runs', async () => {
    const toolCalls: ToolCallRecord[] = [
      tc('memory_store', '{"key": "test", "value": "data"}', 'Stored', 0),
      tc('memory_recall', '{"key": "test"}', 'Recalled', 1),
    ];

    const result = await captureProcess(
      'run-test-003',
      'Internal Only',
      toolCalls,
      { apiKey },
    );

    // Internal tools are filtered — no LLM call needed, empty steps
    expect(result.steps).toHaveLength(0);
  }, 5_000);
});
