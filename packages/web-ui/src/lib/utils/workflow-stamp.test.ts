import { describe, it, expect } from 'vitest';
import {
  STEP_TASK_HEAD, awaitsLineKey, awaitsStampRefusal, confirmOutcome, offersStamp, onceTriggersLine, parseStampPreview, stepHeading, templateText, timeoutText, visible,
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

describe('parseStampPreview — a field that decides what runs is read whole or not at all', () => {
  const step = (over: Record<string, unknown>): Record<string, unknown> => preview({ steps: [{ id: 'a', task: 't', tool: null, inputTemplate: null, tools: [], model: null, inputFrom: [], ...over }] });

  it('refuses a step whose call, tools, model or inputs are present but not of their type', () => {
    for (const over of [{ tool: 7 }, { tools: 'http_request' }, { tools: [{ name: 'http_request' }] }, { tools: ['web_search', 3] }, { model: {} }, { inputFrom: 'fetch' }]) {
      expect(parseStampPreview(step(over)), JSON.stringify(over)).toBeNull();
    }
  });

  it("refuses a call's input without the call, since the input is printed under the call", () => {
    expect(parseStampPreview(step({ inputTemplate: { url: 'https://other.example/' } }))).toBeNull();
  });

  it('refuses a contract with an entry it cannot list, and parameters it cannot read', () => {
    expect(parseStampPreview(preview({ contract: [{ method: 'POST' }] }))).toBeNull();
    expect(parseStampPreview(preview({ contract: ['POST https://a.example/', 5] }))).toBeNull();
    expect(parseStampPreview(preview({ parameters: [{ required: true }] }))).toBeNull();
    expect(parseStampPreview(preview({ parameters: 'month' }))).toBeNull();
    expect(parseStampPreview(preview({ mode: 1 }))).toBeNull();
    expect(parseStampPreview(preview({ onFailure: false }))).toBeNull();
  });

  it('reads absent or null as none (twin of the refusals)', () => {
    const p = parseStampPreview(preview({ parameters: undefined, contract: null, mode: null, onFailure: undefined, steps: [{ id: 'a', task: 't' }] }))!;
    expect(p).not.toBeNull();
    expect([p.parameters, p.contract, p.mode, p.onFailure, p.steps[0]!.tools, p.steps[0]!.tool]).toEqual([[], null, null, null, [], null]);
  });
});

describe('parseStampPreview — role, effort, thinking and time limit (contract r3)', () => {
  const step = (over: Record<string, unknown>): Record<string, unknown> => preview({ steps: [{ id: 'a', task: 't', ...over }] });

  it('reads them when set, and as none when absent or null', () => {
    const p = parseStampPreview(step({ role: 'researcher', effort: 'high', thinking: 'adaptive', timeoutMs: 90_000 }))!;
    expect(p.steps[0]).toMatchObject({ role: 'researcher', effort: 'high', thinking: 'adaptive', timeoutMs: 90_000 });
    const q = parseStampPreview(step({ role: null, effort: null, thinking: null, timeoutMs: null }))!;
    expect(q.steps[0]).toMatchObject({ role: null, effort: null, thinking: null, timeoutMs: null });
    expect(parseStampPreview(step({}))!.steps[0]).toMatchObject({ role: null, effort: null, thinking: null, timeoutMs: null });
  });

  it('refuses a value it cannot show truthfully: a role must not vanish while still being stamped', () => {
    for (const over of [{ role: 3 }, { effort: 'huge' }, { effort: 2 }, { thinking: true }, { thinking: 'on' }, { timeoutMs: '90s' }, { timeoutMs: -1 }, { timeoutMs: Number.NaN }]) {
      expect(parseStampPreview(step(over)), JSON.stringify(over)).toBeNull();
    }
  });

  it('reads a workflow with no steps: it runs nothing, and can be stamped', () => {
    expect(parseStampPreview(preview({ steps: [] }))!.steps).toEqual([]);
  });
});

describe('timeoutText — a time limit in seconds or minutes, never raw milliseconds', () => {
  it('rounds up to whole seconds below a minute, and shows minutes above', () => {
    expect([timeoutText(500), timeoutText(30_000), timeoutText(59_001), timeoutText(60_000), timeoutText(150_000)])
      .toEqual(['1 s', '30 s', '1 min', '1 min', '2 min 30 s']);
  });
});

describe('onceTriggersLine — plans that run only once stay off after the stamp', () => {
  it('names one, or many, and says nothing for none', () => {
    expect(onceTriggersLine(1)).toEqual({ key: 'workflow_library.stamp.once_one', n: 1 });
    expect(onceTriggersLine(3)).toEqual({ key: 'workflow_library.stamp.once_many', n: 3 });
    expect(onceTriggersLine(0)).toBeNull();
  });

  it('words it as a condition when the engine does not count', () => {
    for (const v of [undefined, null, '2', 1.5, -1]) {
      expect(onceTriggersLine(v), String(v)).toEqual({ key: 'workflow_library.stamp.once_unknown', n: 0 });
    }
  });
});

describe("awaitsLineKey — the owner's own change reads differently", () => {
  it('words the line by who changed the workflow', () => {
    expect(awaitsLineKey('owner')).toBe('workflow_library.stamp.awaits_at_schedule_own');
    expect(awaitsLineKey('mandate')).toBe('workflow_library.stamp.awaits_at_schedule');
    expect(awaitsLineKey(null)).toBe('workflow_library.stamp.awaits_at_schedule');
  });
});

describe('visible — what changes how text reads is printed, not applied', () => {
  it('prints direction overrides, isolates and zero-width characters as their code point', () => {
    expect(visible('https://evil\u202Eelpmaxe.com/')).toBe('https://evil<U+202E>elpmaxe.com/');
    expect(visible('a\u2066b\u200Bc\uFEFF')).toBe('a<U+2066>b<U+200B>c<U+FEFF>');
    expect(visible('plain text — ok')).toBe('plain text — ok');
    // Tag characters: invisible on screen, read by a model.
    expect(visible('send it\u{E0049}\u{E0067}')).toBe('send it<U+E0049><U+E0067>');
    expect(visible('Grüße 😀')).toBe('Grüße 😀');
    // Supplementary variation selectors carry data as well.
    expect(visible('ok\u{E0100}\u{E01EF}')).toBe('ok<U+E0100><U+E01EF>');
  });

  it('applies to the recorded call and the step heading', () => {
    expect(templateText({ url: 'https://a\u202Eb/' })).toContain('<U+202E>');
    expect(stepHeading({ id: 'x\u202E', task: 'send\u202E' })).toEqual({ id: 'x<U+202E>', head: 'send<U+202E>' });
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
