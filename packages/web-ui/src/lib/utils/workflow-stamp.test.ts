import { describe, it, expect } from 'vitest';
import {
  STEP_TASK_HEAD, awaitsStampRefusal, confirmOutcome, offersStamp, parseStampPreview, stepHeading, templateText,
} from './workflow-stamp.js';

/** An answer of `GET /api/workflows/:id/stamp-preview` as the contract (242 r1) describes it. */
function preview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expect: 'digest-1',
    stampedAt: null,
    changedBy: 'mandate',
    awaitsStamp: true,
    mode: 'autonomous',
    parameters: [{ name: 'month', required: true, default: null }],
    onFailure: 'stop',
    limits: { maxSteps: 5 },
    contract: ['POST https://api.example.com/v1/reports'],
    steps: [
      { id: 'fetch', task: 'Read the report', tool: null, inputTemplate: null, tools: ['web_search'], model: 'fast', inputFrom: [] },
      { id: 'post', task: 'Send it', tool: 'http_request', inputTemplate: { url: 'https://other.example/{{params.month}}' }, tools: ['http_request'], model: null, inputFrom: ['fetch'] },
    ],
    ...over,
  };
}

describe('parseStampPreview — what the view may show, or nothing', () => {
  it('reads a whole answer, every step and its recorded call', () => {
    const p = parseStampPreview(preview())!;
    expect(p.expect).toBe('digest-1');
    expect(p.steps.map((s) => s.id)).toEqual(['fetch', 'post']);
    expect(p.steps[1]).toMatchObject({ tool: 'http_request', inputTemplate: { url: 'https://other.example/{{params.month}}' }, inputFrom: ['fetch'] });
    expect(p.contract).toEqual(['POST https://api.example.com/v1/reports']);
    expect(p.parameters).toEqual([{ name: 'month', required: true, default: null }]);
    expect(p.changedBy).toBe('mandate');
    expect(p.awaitsStamp).toBe(true);
  });

  it('refuses an answer without a digest: no stamp can be sent for it', () => {
    expect(parseStampPreview(preview({ expect: undefined }))).toBeNull();
    expect(parseStampPreview(preview({ expect: '' }))).toBeNull();
    expect(parseStampPreview(null)).toBeNull();
    expect(parseStampPreview('nope')).toBeNull();
  });

  it('refuses the whole answer when ONE step cannot be read, instead of dropping that step', () => {
    // Dropping it would show every step but the one that differs, and the digest still covers it.
    const steps = (preview()['steps'] as unknown[]).concat([{ id: 'hidden' }]);
    expect(parseStampPreview(preview({ steps }))).toBeNull();
    expect(parseStampPreview(preview({ steps: 'all of them' }))).toBeNull();
  });

  it('refuses a contract it cannot list, and reads a missing one as none', () => {
    expect(parseStampPreview(preview({ contract: { methods: ['POST'] } }))).toBeNull();
    expect(parseStampPreview(preview({ contract: null }))!.contract).toBeNull();
    expect(parseStampPreview(preview({ contract: undefined }))!.contract).toBeNull();
  });
});

describe('stepHeading — there is no step name, so id and the start of the task', () => {
  it('keeps a short task whole and flattens its whitespace', () => {
    expect(stepHeading({ id: 'a', task: '  Read\n the   report ' })).toEqual({ id: 'a', head: 'Read the report' });
  });

  it('cuts a long task at the limit and marks the cut', () => {
    const head = stepHeading({ id: 'a', task: 'x'.repeat(STEP_TASK_HEAD + 5) }).head;
    expect(head).toBe(`${'x'.repeat(STEP_TASK_HEAD)}…`);
    expect(stepHeading({ id: 'a', task: 'x'.repeat(STEP_TASK_HEAD) }).head).toBe('x'.repeat(STEP_TASK_HEAD));
  });

  it('never cuts inside a character made of two code units', () => {
    const head = stepHeading({ id: 'a', task: `${'x'.repeat(STEP_TASK_HEAD - 1)}😀tail` }).head;
    expect(head).toBe(`${'x'.repeat(STEP_TASK_HEAD - 1)}😀…`);
  });
});

describe('templateText — the recorded call, printed', () => {
  it('prints an object whole, a string as it is, and nothing for none', () => {
    expect(templateText({ url: 'https://other.example/x' })).toContain('https://other.example/x');
    expect(templateText('literal')).toBe('literal');
    expect(templateText(null)).toBe('');
    expect(templateText(undefined)).toBe('');
  });
});

describe('offersStamp — only the owner, only where a stamp is awaited', () => {
  it('offers it to the owner of a workflow that waits', () => {
    expect(offersStamp({ awaitsStamp: true }, 'owner')).toBe(true);
  });

  it('offers nothing to a helper, to an unnamed reader, or where nothing waits', () => {
    expect(offersStamp({ awaitsStamp: true }, 'mandate')).toBe(false);
    expect(offersStamp({ awaitsStamp: true }, undefined)).toBe(false);
    expect(offersStamp({ awaitsStamp: false }, 'owner')).toBe(false);
    expect(offersStamp({}, 'owner')).toBe(false);
  });
});

describe('confirmOutcome — what an answer of the confirm route means', () => {
  it('stamps only on a 2xx', () => {
    expect(confirmOutcome(200, undefined)).toEqual({ kind: 'stamped' });
  });

  it('reads 409 steps_changed as "load the new version and ask again"', () => {
    expect(confirmOutcome(409, 'steps_changed')).toEqual({ kind: 'changed' });
  });

  it('reads every other answer as a failure, never as stamped', () => {
    for (const [status, code] of [[409, undefined], [409, 'changed'], [409, 'workflow_awaits_stamp'], [400, 'expect_required'], [403, undefined], [500, 'steps_changed']] as const) {
      expect(confirmOutcome(status, code).kind, `${status} ${String(code)}`).toBe('failed');
    }
  });
});

describe('awaitsStampRefusal — a refused schedule whose way out is this stamp', () => {
  const body = { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' };

  it('recognises the refusal for the workflow being scheduled', () => {
    expect(awaitsStampRefusal(409, body, 'wf-1')).toBe(true);
  });

  it('does not take a refusal for another workflow, another code or another status', () => {
    expect(awaitsStampRefusal(409, body, 'wf-2')).toBe(false);
    expect(awaitsStampRefusal(409, { ...body, code: 'changed' }, 'wf-1')).toBe(false);
    expect(awaitsStampRefusal(400, body, 'wf-1')).toBe(false);
    expect(awaitsStampRefusal(409, null, 'wf-1')).toBe(false);
  });
});
