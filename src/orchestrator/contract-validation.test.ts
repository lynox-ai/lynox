import { describe, it, expect } from 'vitest';
import { validateContractAgainstSteps } from './contract-validation.js';
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
});
