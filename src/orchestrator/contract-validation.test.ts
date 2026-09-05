import { describe, it, expect } from 'vitest';
import { validateContractAgainstSteps, mintContractFromSteps } from './contract-validation.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import type { InlinePipelineStep } from '../types/pipeline.js';

const baseContract: CapabilityContract = {
  version: 1,
  grantedTools: ['http_request'],
  httpMethods: ['POST'],
  hostPatterns: ['api.acme.test'],
  pathPatterns: ['/v1/*'],
  paramConstraints: {},
};

const step = (input_template: Record<string, unknown>): InlinePipelineStep => ({
  id: 's1',
  task: 'replay',
  tool: 'http_request',
  input_template,
});

describe('validateContractAgainstSteps', () => {
  it('returns null when there is no contract (ungoverned workflow unaffected)', () => {
    expect(validateContractAgainstSteps({ steps: [step({ url: 'https://api.acme.test/v1/x' })] })).toBeNull();
  });

  it('rejects a contract whose step references an unconstrained param', () => {
    const err = validateContractAgainstSteps({
      capabilityContract: baseContract,
      steps: [step({ url: 'https://api.acme.test/v1/{{params.customer}}' })],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('customer');
  });

  it('accepts a contract when every referenced param is constrained', () => {
    const contract: CapabilityContract = {
      ...baseContract,
      paramConstraints: { customer: { regex: '^[a-z0-9-]+$' } },
    };
    expect(validateContractAgainstSteps({
      capabilityContract: contract,
      steps: [step({ url: 'https://api.acme.test/v1/{{params.customer}}' })],
    })).toBeNull();
  });

  it('rejects a match-anything host pattern (fleet-wide egress grant)', () => {
    for (const hostPatterns of [['*'], ['**'], ['api.acme.test', '*']]) {
      const err = validateContractAgainstSteps({
        capabilityContract: { ...baseContract, hostPatterns },
        steps: [step({ url: 'https://api.acme.test/v1/x' })],
      });
      expect(err).not.toBeNull();
      expect(err).toContain('any host');
    }
  });

  it('accepts a bounded subdomain wildcard host pattern', () => {
    expect(validateContractAgainstSteps({
      capabilityContract: { ...baseContract, hostPatterns: ['*.googleapis.com'] },
      steps: [step({ url: 'https://x.googleapis.com/v1/x' })],
    })).toBeNull();
  });

  it('detects a param nested deep inside the input template (object + array walk)', () => {
    const err = validateContractAgainstSteps({
      capabilityContract: baseContract,
      steps: [step({ body: { items: ['{{params.secret}}'] } })],
    });
    expect(err).toContain('secret');
  });

  it('tolerates whitespace inside the placeholder', () => {
    const err = validateContractAgainstSteps({
      capabilityContract: baseContract,
      steps: [step({ url: 'https://api.acme.test/v1/{{ params.customer }}' })],
    });
    expect(err).toContain('customer');
  });

  it('a contract with no param-referencing steps is valid', () => {
    expect(validateContractAgainstSteps({
      capabilityContract: baseContract,
      steps: [step({ url: 'https://api.acme.test/v1/reports' })],
    })).toBeNull();
  });

  it('rejects a VACUOUS constraint that constrains nothing (fail-open guard)', () => {
    // An empty `{}` constraint object satisfies key-presence but enforces nothing.
    const errEmptyObj = validateContractAgainstSteps({
      capabilityContract: { ...baseContract, paramConstraints: { customer: {} } },
      steps: [step({ url: 'https://api.acme.test/v1/{{params.customer}}' })],
    });
    expect(errEmptyObj).toContain('customer');
    // An empty `enum: []` likewise constrains nothing.
    const errEmptyEnum = validateContractAgainstSteps({
      capabilityContract: { ...baseContract, paramConstraints: { customer: { enum: [] } } },
      steps: [step({ url: 'https://api.acme.test/v1/{{params.customer}}' })],
    });
    expect(errEmptyEnum).toContain('customer');
  });

  it('catches a NESTED dotted param ref {{params.a.b}} (resolves through the base param)', () => {
    const err = validateContractAgainstSteps({
      capabilityContract: baseContract,
      steps: [step({ url: 'https://api.acme.test/v1/{{params.customer.id}}' })],
    });
    expect(err).toContain('customer');
  });

  // release-harden 2026-06-24: a param name with a non-[a-zA-Z0-9_] char is
  // resolved RAW by the runtime (getByPath splits on '.' only), so the validator
  // must SEE it — a narrower capture made it invisible → fail-open (S1).
  it('catches an unconstrained re-target param with a NON-WORD name (hyphen / $ / leading-unicode)', () => {
    for (const name of ['target-host', 'data$x', 'δata']) {
      const err = validateContractAgainstSteps({
        capabilityContract: baseContract, // constrains nothing
        steps: [step({ url: `https://api.acme.test/v1/{{params.${name}}}` })],
      });
      expect(err, `param "${name}" must be caught as referenced-but-unconstrained`).not.toBeNull();
      expect(err).toContain(name);
    }
  });

  it('accepts a non-word-named param when constrained by its FULL name', () => {
    const err = validateContractAgainstSteps({
      capabilityContract: { ...baseContract, paramConstraints: { 'target-host': { enum: ['acme'] } } },
      steps: [step({ url: 'https://api.acme.test/v1/{{params.target-host}}' })],
    });
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mintContractFromSteps — the producer Slice B1 left out.
//
// The refusals matter more than the mint: each one is a shape where a derived
// grant would be a guess, and the validator would reject or fail open on it.
// ---------------------------------------------------------------------------

describe('mintContractFromSteps', () => {
  const httpStep = (id: string, template: Record<string, unknown>): InlinePipelineStep =>
    ({ id, task: 'call it', tool: 'http_request', input_template: template });

  it('mints a pinned grant for a fully literal write', () => {
    const c = mintContractFromSteps([httpStep('s1', { url: 'https://api.example.com/orders', method: 'POST' })]);
    expect(c).toBeDefined();
    expect(c!.grantedTools).toEqual(['http_request']);
    expect(c!.httpMethods).toEqual(['POST']);
    expect(c!.hostPatterns).toEqual(['api.example.com']);
    expect(c!.pathPatterns).toEqual(['/orders']);
    expect(c!.paramConstraints).toEqual({});
  });

  it('records that the grant came from authorship, not review', () => {
    const c = mintContractFromSteps([httpStep('s1', { url: 'https://api.example.com/orders', method: 'POST' })]);
    expect(c!.origin).toBe('authorship');
  });

  // THE boundary. A parameter reaching any tool call means the grant would have
  // to say which values are admissible, and nothing in the template says so.
  it('refuses when a parameter reaches the writing call', () => {
    expect(mintContractFromSteps([
      httpStep('s1', { url: 'https://api.example.com/{{ params.target }}', method: 'POST' }),
    ])).toBeUndefined();
  });

  // Checked across ALL steps, not just the writing one: a contract minted while
  // another step is parameterised is rejected by its own save validator.
  it('refuses when a parameter reaches a DIFFERENT step', () => {
    expect(mintContractFromSteps([
      { id: 's0', task: 'read', tool: 'read_file', input_template: { path: '{{ params.path }}' } },
      httpStep('s1', { url: 'https://api.example.com/orders', method: 'POST' }),
    ])).toBeUndefined();
  });

  it('mints nothing for a read-only workflow', () => {
    expect(mintContractFromSteps([httpStep('s1', { url: 'https://api.example.com/x', method: 'GET' })])).toBeUndefined();
    expect(mintContractFromSteps([{ id: 's1', task: 'think' }])).toBeUndefined();
  });

  it('refuses a write whose target is not a literal absolute URL', () => {
    expect(mintContractFromSteps([httpStep('s1', { url: 42, method: 'POST' })])).toBeUndefined();
    expect(mintContractFromSteps([httpStep('s1', { url: '/relative/only', method: 'POST' })])).toBeUndefined();
  });

  it('covers every write method and host the workflow actually uses', () => {
    const c = mintContractFromSteps([
      httpStep('s1', { url: 'https://a.example.com/one', method: 'POST' }),
      httpStep('s2', { url: 'https://b.example.com/two', method: 'PATCH' }),
    ]);
    expect(c!.httpMethods.sort()).toEqual(['PATCH', 'POST']);
    expect(c!.hostPatterns.sort()).toEqual(['a.example.com', 'b.example.com']);
  });

  // The mint and the save gate must agree: a contract this produces has to
  // survive the validator that runs on every save, or minting wedges saving.
  it('produces a contract its own save validator accepts', () => {
    const steps = [httpStep('s1', { url: 'https://api.example.com/orders', method: 'POST' })];
    const capabilityContract = mintContractFromSteps(steps);
    expect(validateContractAgainstSteps({ capabilityContract, steps })).toBeNull();
  });
});
