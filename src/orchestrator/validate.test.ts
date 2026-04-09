import { describe, it, expect } from 'vitest';
import { validateManifest } from './validate.js';

const validManifest = {
  manifest_version: '1.0',
  name: 'test-manifest',
  triggered_by: 'user',
  agents: [
    { id: 'step-1', agent: 'my-agent', runtime: 'mock' },
  ],
};

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest(validManifest);
    expect(result.name).toBe('test-manifest');
    expect(result.agents).toHaveLength(1);
    expect(result.gate_points).toEqual([]);
    expect(result.on_failure).toBe('stop');
    expect(result.context).toEqual({});
  });

  it('accepts a full manifest with all optional fields', () => {
    const full = {
      ...validManifest,
      context: { env: 'prod' },
      gate_points: ['step-1'],
      on_failure: 'continue',
      agents: [
        {
          id: 'step-1',
          agent: 'my-agent',
          runtime: 'agent',
          model: 'sonnet',
          input_from: ['step-0'],
          conditions: [{ path: 'x', operator: 'gt', value: 5 }],
          timeout_ms: 30000,
          output_schema: { type: 'object' },
          tool_gates: ['some_tool'],
        },
      ],
    };
    const result = validateManifest(full);
    expect(result.on_failure).toBe('continue');
    const step = result.agents[0]!;
    expect(step.tool_gates).toEqual(['some_tool']);
    expect(step.conditions?.[0]?.operator).toBe('gt');
  });

  it('throws when manifest_version is wrong', () => {
    expect(() => validateManifest({ ...validManifest, manifest_version: '2.0' }))
      .toThrow('Invalid manifest');
  });

  it('throws when name is missing', () => {
    const bad = { ...validManifest };
    const { name: _n, ...rest } = bad;
    expect(() => validateManifest(rest)).toThrow('Invalid manifest');
  });

  it('throws when agents array is empty', () => {
    expect(() => validateManifest({ ...validManifest, agents: [] }))
      .toThrow('Invalid manifest');
  });

  it('throws when step runtime is invalid', () => {
    const bad = {
      ...validManifest,
      agents: [{ id: 'x', agent: 'a', runtime: 'invalid' }],
    };
    expect(() => validateManifest(bad)).toThrow('Invalid manifest');
  });

  it('throws when step id is empty string', () => {
    const bad = {
      ...validManifest,
      agents: [{ id: '', agent: 'a', runtime: 'mock' }],
    };
    expect(() => validateManifest(bad)).toThrow('Invalid manifest');
  });

  it('throws when on_failure has invalid value', () => {
    expect(() => validateManifest({ ...validManifest, on_failure: 'crash' }))
      .toThrow('Invalid manifest');
  });

  it('throws for non-object input', () => {
    expect(() => validateManifest(null)).toThrow('Invalid manifest');
    expect(() => validateManifest('string')).toThrow('Invalid manifest');
    expect(() => validateManifest(42)).toThrow('Invalid manifest');
  });

  it('throws when step timeout_ms is not positive', () => {
    const bad = {
      ...validManifest,
      agents: [{ id: 'x', agent: 'a', runtime: 'mock', timeout_ms: -1 }],
    };
    expect(() => validateManifest(bad)).toThrow('Invalid manifest');
  });

  it('applies defaults: context={}, gate_points=[], on_failure=stop', () => {
    const minimal = {
      manifest_version: '1.0',
      name: 'x',
      triggered_by: 'y',
      agents: [{ id: 'a', agent: 'b', runtime: 'mock' }],
    };
    const result = validateManifest(minimal);
    expect(result.context).toEqual({});
    expect(result.gate_points).toEqual([]);
    expect(result.on_failure).toBe('stop');
  });

  it('validates ManifestStep with pre_approve field', () => {
    const result = validateManifest({
      ...validManifest,
      agents: [{
        id: 'step-1',
        agent: 'agent-a',
        runtime: 'mock',
        pre_approve: [
          { tool: 'bash', pattern: 'npm run *', risk: 'low' },
          { tool: 'write_file', pattern: 'dist/**' },
        ],
      }],
    });
    expect(result.agents[0]!.pre_approve).toHaveLength(2);
    expect(result.agents[0]!.pre_approve![0]!.tool).toBe('bash');
  });

  it('validates ManifestStep without pre_approve field', () => {
    const result = validateManifest(validManifest);
    expect(result.agents[0]!.pre_approve).toBeUndefined();
  });
});

describe('validateManifest — v1.1', () => {
  const v11Base = {
    manifest_version: '1.1',
    name: 'v11-test',
    triggered_by: 'user',
    agents: [
      { id: 'step-1', agent: 'my-agent', runtime: 'mock' },
    ],
  };

  it('accepts v1.1 without execution field (defaults to parallel)', () => {
    const result = validateManifest(v11Base);
    expect(result.manifest_version).toBe('1.1');
    expect(result.execution).toBe('parallel');
  });

  it('accepts v1.1 with execution: sequential', () => {
    const result = validateManifest({ ...v11Base, execution: 'sequential' });
    expect(result.execution).toBe('sequential');
  });

  it('accepts v1.1 with execution: parallel', () => {
    const result = validateManifest({ ...v11Base, execution: 'parallel' });
    expect(result.execution).toBe('parallel');
  });

  it('rejects v1.1 with duplicate step IDs', () => {
    expect(() => validateManifest({
      ...v11Base,
      agents: [
        { id: 'a', agent: 'x', runtime: 'mock' },
        { id: 'a', agent: 'y', runtime: 'mock' },
      ],
    })).toThrow('Duplicate step ID');
  });

  it('rejects v1.1 with self-loops', () => {
    expect(() => validateManifest({
      ...v11Base,
      agents: [
        { id: 'a', agent: 'x', runtime: 'mock', input_from: ['a'] },
      ],
    })).toThrow('Self-loop');
  });

  it('rejects v1.1 with orphan refs', () => {
    expect(() => validateManifest({
      ...v11Base,
      agents: [
        { id: 'a', agent: 'x', runtime: 'mock', input_from: ['z'] },
      ],
    })).toThrow('Orphan reference');
  });

  it('rejects v1.1 with cycles', () => {
    expect(() => validateManifest({
      ...v11Base,
      agents: [
        { id: 'a', agent: 'x', runtime: 'mock', input_from: ['b'] },
        { id: 'b', agent: 'y', runtime: 'mock', input_from: ['a'] },
      ],
    })).toThrow('cycle');
  });

  it('accepts inline runtime with task field', () => {
    const result = validateManifest({
      ...v11Base,
      agents: [
        { id: 'step-1', agent: 'step-1', runtime: 'inline', task: 'Do something' },
      ],
    });
    expect(result.agents[0]!.runtime).toBe('inline');
    expect(result.agents[0]!.task).toBe('Do something');
  });

  it('rejects inline runtime without task field', () => {
    expect(() => validateManifest({
      ...v11Base,
      agents: [
        { id: 'step-1', agent: 'step-1', runtime: 'inline' },
      ],
    })).toThrow('"task" is required when runtime is "inline"');
  });

  it('v1.0 validation unchanged (no graph checks for orphan refs)', () => {
    // v1.0 with orphan ref should still pass validation (fails at runtime)
    const result = validateManifest({
      ...validManifest,
      agents: [
        { id: 'a', agent: 'x', runtime: 'mock', input_from: ['nonexistent'] },
      ],
    });
    expect(result.manifest_version).toBe('1.0');
  });
});
