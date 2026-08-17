import { describe, it, expect } from 'vitest';
import { validateManifest, assertPipelineModeIsValid, assertPlannedPipelineIsValid, AutonomousPipelineViolation, MAX_STEPS, ABSOLUTE_MAX_STEPS, maxStepsFor, parallelStepCapFor } from './validate.js';
import type { InlinePipelineStep, PlannedPipeline } from '../types/index.js';

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
          model: 'balanced',
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

  it('accepts an agents array exactly at the MAX_STEPS ceiling', () => {
    const atCeiling = Array.from({ length: MAX_STEPS }, (_, i) => ({
      id: `step-${String(i)}`, agent: 'my-agent', runtime: 'mock' as const,
    }));
    expect(() => validateManifest({ ...validManifest, agents: atCeiling }))
      .not.toThrow();
  });

  it('throws when agents array exceeds the absolute sanity ceiling (schema backstop)', () => {
    // The policy cap (MAX_STEPS=20, config-overridable via max_workflow_steps) is
    // enforced on the run paths in pipeline.ts, NOT in the zod schema — so 21
    // agents no longer throws here. The schema keeps ABSOLUTE_MAX_STEPS as a
    // sanity backstop against pathological manifests regardless of config.
    const overSanity = Array.from({ length: ABSOLUTE_MAX_STEPS + 1 }, (_, i) => ({
      id: `step-${String(i)}`, agent: 'my-agent', runtime: 'mock' as const,
    }));
    expect(() => validateManifest({ ...validManifest, agents: overSanity }))
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

describe('assertPipelineModeIsValid (save-time gate)', () => {
  const mkStep = (id: string, task: string): InlinePipelineStep => ({ id, task });

  it('passes when mode is interactive (no restrictions)', () => {
    expect(() => assertPipelineModeIsValid(
      [mkStep('vote', 'ask_user which option')],
      'interactive',
    )).not.toThrow();
  });

  it('passes when mode is autonomous and no HITL tools referenced', () => {
    expect(() => assertPipelineModeIsValid(
      [mkStep('a', 'http GET /report'), mkStep('b', 'summarize the response')],
      'autonomous',
    )).not.toThrow();
  });

  it('throws AutonomousPipelineViolation with per-step issues for ask_user', () => {
    let caught: unknown;
    try {
      assertPipelineModeIsValid(
        [mkStep('safe', 'compute'), mkStep('vote', 'ask_user which tagline')],
        'autonomous',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AutonomousPipelineViolation);
    const violation = caught as AutonomousPipelineViolation;
    expect(violation.issues).toHaveLength(1);
    expect(violation.issues[0]).toMatchObject({ stepId: 'vote', tool: 'ask_user' });
    expect(violation.message).toContain('vote');
    expect(violation.message).toContain('ask_user');
    expect(violation.message).toContain('autonomous');
  });

  it('throws for ask_secret in autonomous pipelines', () => {
    expect(() => assertPipelineModeIsValid(
      [mkStep('grab', 'ask_secret api_key from user')],
      'autonomous',
    )).toThrow(/ask_secret/);
  });

  it('throws for ask_human in autonomous pipelines', () => {
    expect(() => assertPipelineModeIsValid(
      [mkStep('escalate', 'ask_human for review')],
      'autonomous',
    )).toThrow(/ask_human/);
  });

  it('aggregates multiple violations into one error', () => {
    let caught: unknown;
    try {
      assertPipelineModeIsValid(
        [mkStep('a', 'ask_user'), mkStep('b', 'ask_secret')],
        'autonomous',
      );
    } catch (err) {
      caught = err;
    }
    const violation = caught as AutonomousPipelineViolation;
    expect(violation.issues).toHaveLength(2);
    expect(violation.message).toMatch(/2 steps/);
  });
});

describe('assertPlannedPipelineIsValid', () => {
  const basePipeline: Omit<PlannedPipeline, 'mode' | 'steps'> = {
    id: 'p1',
    name: 'test',
    goal: 'goal',
    reasoning: 'r',
    estimatedCost: 0,
    createdAt: new Date().toISOString(),
    executed: false,
    executionMode: 'orchestrated',
    template: false,
  };

  it('rejects autonomous pipeline that calls ask_user', () => {
    expect(() => assertPlannedPipelineIsValid({
      ...basePipeline,
      steps: [{ id: 'q', task: 'ask_user something' }],
      mode: 'autonomous',
    })).toThrow(AutonomousPipelineViolation);
  });

  it('accepts interactive pipeline with ask_user', () => {
    expect(() => assertPlannedPipelineIsValid({
      ...basePipeline,
      steps: [{ id: 'q', task: 'ask_user something' }],
      mode: 'interactive',
    })).not.toThrow();
  });
});

describe('assertDeclaredToolsAreValid (F2/D2 save-time gate)', () => {
  const basePipeline: Omit<PlannedPipeline, 'mode' | 'steps'> = {
    id: 'p2',
    name: 'test-tools',
    goal: 'goal',
    reasoning: 'r',
    estimatedCost: 0,
    createdAt: new Date().toISOString(),
    executed: false,
    executionMode: 'orchestrated',
    template: false,
  };

  it('rejects a declared tool name outside the inline pool, naming the step', () => {
    expect(() => assertPlannedPipelineIsValid({
      ...basePipeline,
      steps: [{ id: 'bad-step', task: 'do', tools: ['htp_request'] }],
      mode: 'autonomous',
    })).toThrow(/bad-step.*htp_request/);
  });

  it('accepts a declared set drawn from the pool (incl. bash)', () => {
    expect(() => assertPlannedPipelineIsValid({
      ...basePipeline,
      steps: [{ id: 's', task: 'do', tools: ['http_request', 'bash'] }],
      mode: 'autonomous',
    })).not.toThrow();
  });

  it('accepts steps that declare nothing (legacy manifests)', () => {
    expect(() => assertPlannedPipelineIsValid({
      ...basePipeline,
      steps: [{ id: 's', task: 'do' }],
      mode: 'autonomous',
    })).not.toThrow();
  });
});

describe('validateManifest preserves step.tools (zod strips unknown keys)', () => {
  it('keeps the declared tool set on the validated result', () => {
    const manifest = validateManifest({
      manifest_version: '1.0',
      name: 'm',
      triggered_by: 't',
      agents: [{ id: 'a', agent: 'a', runtime: 'inline', task: 'do', tools: ['http_request'] }],
    });
    expect(manifest.agents[0]!.tools).toEqual(['http_request']);
  });
});

describe('validateManifest applies the declared-tools gate (F2 fix round)', () => {
  it('rejects a typo\'d declared tool on an inline manifest step', () => {
    expect(() => validateManifest({
      manifest_version: '1.0',
      name: 'm', triggered_by: 't',
      agents: [{ id: 'a', agent: 'a', runtime: 'inline', task: 'do', tools: ['htp_request'] }],
    })).toThrow(/htp_request/);
  });

  it('rejects a typo\'d declared tool on a NESTED pipeline step', () => {
    expect(() => validateManifest({
      manifest_version: '1.1',
      name: 'm', triggered_by: 't',
      agents: [{
        id: 'outer', agent: 'outer', runtime: 'pipeline',
        pipeline: [{ id: 'inner', task: 'do', tools: ['no_such_tool'] }],
      }],
    })).toThrow(/no_such_tool/);
  });

  it('rejects a declaration that excludes the step\'s own replay tool', () => {
    expect(() => validateManifest({
      manifest_version: '1.0',
      name: 'm', triggered_by: 't',
      agents: [{ id: 'a', agent: 'a', runtime: 'inline', task: 'replay', tools: ['read_file'], tool: 'bash', input_template: {} }],
    })).toThrow(/replays tool "bash"/);
  });

  it('accepts an UNDECLARED replay step with a non-pool tool (captured workflows degrade gracefully)', () => {
    // Captured workflows legitimately carry non-pool tools; the runtime falls
    // back to the prose task when the replay tool is not granted. The gate
    // must not reject stored data that works today.
    expect(() => validateManifest({
      manifest_version: '1.0',
      name: 'm', triggered_by: 't',
      agents: [{ id: 'a', agent: 'a', runtime: 'inline', task: 'replay artifact save', tool: 'artifact_save', input_template: {} }],
    })).not.toThrow();
  });

  it('accepts a declared empty array (a "no tools" declaration)', () => {
    expect(() => validateManifest({
      manifest_version: '1.0',
      name: 'm', triggered_by: 't',
      agents: [{ id: 'a', agent: 'a', runtime: 'inline', task: 'reason', tools: [] }],
    })).not.toThrow();
  });
});

describe('maxStepsFor', () => {
  it('returns the default for absent/malformed config, the override when valid, clamped to the ceiling', () => {
    expect(maxStepsFor()).toBe(MAX_STEPS);
    expect(maxStepsFor({})).toBe(MAX_STEPS);
    expect(maxStepsFor({ max_workflow_steps: 0 })).toBe(MAX_STEPS);   // 0 would reject every workflow
    expect(maxStepsFor({ max_workflow_steps: -5 })).toBe(MAX_STEPS);  // negative
    expect(maxStepsFor({ max_workflow_steps: NaN })).toBe(MAX_STEPS); // NaN disables the cap silently
    expect(maxStepsFor({ max_workflow_steps: 40 })).toBe(40);         // valid override
    expect(maxStepsFor({ max_workflow_steps: 5000 })).toBe(ABSOLUTE_MAX_STEPS); // clamped to sanity ceiling
  });
});

describe('parallelStepCapFor', () => {
  it('keeps ABSENT meaning unbounded — the documented v1.1 phase behaviour', () => {
    // The one case that must stay `undefined`: no limits object at all means
    // "launch the whole phase", which the limit-less parallel test pins.
    expect(parallelStepCapFor(undefined, 5)).toBeUndefined();
  });

  it('never lets a MALFORMED width mean "no bound at all"', () => {
    // The regression this exists for: `cap > 0` treated every one of these as
    // "unset" and fell through to unbounded fan-out. A present value is a
    // REQUEST for a bound, so the malformed forms must resolve to the fallback.
    // `null` is in the list because it is the form that actually PERSISTS:
    // JSON.stringify turns both NaN and Infinity into null, so a stored
    // limits blob can never carry the other two.
    for (const bad of [0, -1, -0.5, NaN, -Infinity, null as unknown as number]) {
      expect(parallelStepCapFor(bad, 5), `maxParallelSteps: ${String(bad)}`).toBe(5);
    }
  });

  it('treats Infinity as the "no limit" sentinel it is, NOT as malformed', () => {
    // The safe direction points backwards here, which is why it gets its own
    // test. Infinity is the idiomatic JS "no bound", and the pre-clamp executor
    // honoured it exactly (Math.min(Infinity, N) = N). Lumping it in with NaN
    // would give the caller who asked most explicitly for NO bound the tightest
    // one — a 180° inversion of intent, and silent.
    expect(parallelStepCapFor(Infinity, 5)).toBeUndefined();
    expect(parallelStepCapFor(Infinity, 1)).toBeUndefined();
    // …while its nonsense twin still takes the fallback.
    expect(parallelStepCapFor(-Infinity, 5)).toBe(5);
  });

  it('passes a valid width through, truncated to a whole number of workers', () => {
    expect(parallelStepCapFor(3, 5)).toBe(3);
    expect(parallelStepCapFor(1, 5)).toBe(1);
    expect(parallelStepCapFor(2.9, 5)).toBe(2); // a worker pool is integral
  });

  it('honours the caller-supplied fallback, so each layer picks its own safe width', () => {
    // The executor passes 1 (tightest bound); the in-session resolver passes its
    // default. Same helper, different safe direction per layer.
    expect(parallelStepCapFor(0, 1)).toBe(1);
    expect(parallelStepCapFor(0, 5)).toBe(5);
  });
});
