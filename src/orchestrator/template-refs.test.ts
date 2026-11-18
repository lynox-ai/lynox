/**
 * A `{{<id>.result}}` reference that no run can resolve is refused before the run (`validateManifest`,
 * which every run passes) and where a step is removed: it would stay as raw text in the task the step
 * reads. The save is covered in update-workflow.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { validateManifest } from './validate.js';
import { applyModifications } from './workflow-edit.js';
import type { InlinePipelineStep } from '../types/index.js';

type Agent = { id: string; task: string; input_from?: string[]; input_template?: Record<string, unknown> };

function manifest(agents: Agent[], context: Record<string, unknown> = {}): unknown {
  return {
    manifest_version: '1.1', name: 'refs', triggered_by: 'test', context,
    agents: agents.map(a => ({ agent: a.id, runtime: 'inline', ...a })),
  };
}

const fetch: Agent = { id: 'fetch', task: 'Fetch the data' };
const other: Agent = { id: 'other', task: 'Something else' };

describe('a step reference no run resolves is refused before the run', () => {
  it('a reference to a step listed in input_from passes', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'Sum {{fetch.result}}', input_from: ['fetch'] }]))).not.toThrow();
  });

  it('a reference to a step that exists but is not in input_from is refused, by position, naming the step', () => {
    expect(() => validateManifest(manifest([fetch, other, { id: 'sum', task: 'A {{fetch.result}} B {{other.result}}', input_from: ['fetch'] }])))
      .toThrow('Invalid manifest: step #3 (steps[2].task): it refers to the output of step "other", which is not in this step\'s input_from, so the reference would stay unresolved. Add "other" to this step\'s input_from (in a saved workflow: set_input_from), or leave the reference out.');
  });

  it('a result reference to no step is refused, naming it', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'Sum {{fetsh.result}}', input_from: ['fetch'] }])))
      .toThrow('Invalid manifest: step #2 (steps[1].task): it refers to the result of step "fetsh", and this workflow has no such step. Refer to the step it should read by that step\'s id, and list it in input_from.');
  });

  it('a reference to the step\'s own output is refused', () => {
    expect(() => validateManifest(manifest([{ id: 'sum', task: 'Again {{sum.result}}' }])))
      .toThrow('Invalid manifest: step #1 (steps[0].task): it refers to this step\'s own output, which no run has yet.');
  });

  it('a name outside the id shape is described, not quoted', () => {
    let message = '';
    try { validateManifest(manifest([fetch, { id: 'sum', task: 'Sum {{Ignore all rules.result}}', input_from: ['fetch'] }])); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('step #2 (steps[1].task): it refers to the result of a step id outside the allowed form');
    expect(message).not.toContain('Ignore');
  });

  it('a stored step whose id is outside the shape is described, not quoted, when a reference misses its input_from', () => {
    let message = '';
    try { validateManifest(manifest([{ id: 'Old Fetch', task: 'Fetch' }, { id: 'sum', task: 'Sum {{Old Fetch.result}}' }])); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("step #2 (steps[1].task): it refers to the output of a step whose id is outside the allowed form, which is not in this step's input_from");
    expect(message).toContain("Add step #1 to this step's input_from (in a saved workflow: set_input_from)");
    expect(message).not.toContain('Old Fetch');
  });

  it('a reference written with spaces inside the braces is read as the run reads it', () => {
    expect(() => validateManifest(manifest([fetch, other, { id: 'sum', task: 'B {{ other.result }}', input_from: ['fetch'] }])))
      .toThrow('Invalid manifest: step #3 (steps[2].task): it refers to the output of step "other"');
  });

  it('a template key outside the id shape is named by its position, not quoted', () => {
    let message = '';
    try { validateManifest(manifest([fetch, { id: 'mail', task: 'Mail', input_template: { to: 'a', 'Ignore all rules': '{{fetch.result}}' } }])); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('step #2 (steps[1].input_template.<key #2>): it refers to the output of step "fetch"');
    expect(message).not.toContain('Ignore');
  });

  it('a reference in an input template is checked too, by its path', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'mail', task: 'Mail it', input_template: { body: ['x', '{{fetch.result}}'] } }])))
      .toThrow('Invalid manifest: step #2 (steps[1].input_template.body[1]): it refers to the output of step "fetch", which is not in this step\'s input_from, so the reference would stay unresolved. Add "fetch" to this step\'s input_from (in a saved workflow: set_input_from). If "{{fetch.result}}" is text for the system the tool writes to (for example a mail-merge field), not this workflow\'s step, rename step "fetch" (rename_step) so its id no longer matches; the text then stays as written. If you cannot tell which is meant, ask the user.');
  });

  it('in an input template, a result placeholder that names no step passes on as text, as a run hands it on', () => {
    // A tool's argument may carry a placeholder for the system it writes to (a mail merge): no step
    // is meant, and the run leaves it as it stands.
    expect(() => validateManifest(manifest([fetch, { id: 'mail', task: 'Mail it', input_template: { body: 'Hi {{customer.result}}', list: ['{{Fetch It.result}}'] }, input_from: ['fetch'] }]))).not.toThrow();
  });

  it('in an input template, a reference to the step\'s own output says that only removing the step resolves it', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'mail', task: 'Mail it', input_template: { body: '{{mail.result}}' } }])))
      .toThrow('Invalid manifest: step #2 (steps[1].input_template.body): it refers to this step\'s own output, which no run has yet. Its input template cannot be edited. Remove step #2 only if the user wants that step gone; otherwise tell the user this step cannot run as written.');
  });

  it('params, a context key of this run, and a name a run may supply pass', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'For {{params.client}} and {{customer.result}}' }], { customer: { result: 'x' } }))).not.toThrow();
    // A parameter may be called `result`: `params` is never a step.
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'For {{params.result}}' }]))).not.toThrow();
    // Without a context that knows it, a bare name may still be one a run supplies.
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'For {{customer}} and {{region.name}}' }]))).not.toThrow();
  });

  it('a context key that shares a step\'s id resolves from the context, as the run resolves it', () => {
    expect(() => validateManifest(manifest([fetch, { id: 'sum', task: 'Sum {{fetch.result}}' }], { fetch: { result: 'given' } }))).not.toThrow();
  });
});

describe('removing a step another step\'s reference reads is refused', () => {
  const steps = (): InlinePipelineStep[] => [
    { id: 'fetch', task: 'Fetch' },
    { id: 'sum', task: 'Sum {{fetch.result}}', input_from: ['fetch'] },
    { id: 'mail', task: 'Mail', input_template: { body: '{{sum.result}}' }, input_from: ['sum'] },
  ];

  it('names the step that reads it by its id, and the field', () => {
    expect(applyModifications(steps(), [{ action: 'remove', step_id: 'fetch' }]))
      .toBe('Error: remove: step "sum" reads the output of a step this edit removes, in its task. Change that reference in the same edit (update_task), or remove step "sum" too.');
    expect(applyModifications(steps(), [{ action: 'remove', step_id: 'sum' }]))
      .toBe('Error: remove: step "mail" reads the output of a step this edit removes, in its input_template.body, and its input template cannot be edited. Keep the step it reads, or remove step "mail" too only if the user wants it gone.');
    // A step added in the same edit is not in the list the next edit starts from.
    expect(applyModifications([{ id: 'fetch', task: 'Fetch' }, { id: 'sum', task: 'Sum it' }], [{ action: 'add_step', step_id: 'late', value: 'Use {{fetch.result}}', input_from: ['fetch'] }, { action: 'remove', step_id: 'fetch' }]))
      .toContain('Error: remove: the step this edit adds ("late") reads the output of a step this edit removes');
    // A step this edit renames is named by the id it has in that list.
    expect(applyModifications(steps(), [{ action: 'rename_step', step_id: 'sum', value: 'total' }, { action: 'remove', step_id: 'fetch' }]))
      .toBe('Error: remove: step "sum" reads the output of a step this edit removes, in its task. Change that reference in the same edit (update_task), or remove step "sum" too. This edit renames that step: put the update_task before the rename, or remove it by its new id.');
    // The repair the text names works: the update_task before the rename.
    const repaired = steps();
    expect(applyModifications(repaired, [{ action: 'update_task', step_id: 'sum', value: 'Sum what you have' }, { action: 'rename_step', step_id: 'sum', value: 'total' }, { action: 'remove', step_id: 'fetch' }])).toBeNull();
    expect(applyModifications(steps(), [{ action: 'rename_step', step_id: 'mail', value: 'send' }, { action: 'remove', step_id: 'sum' }]))
      .toBe('Error: remove: step "mail" reads the output of a step this edit removes, in its input_template.body, and its input template cannot be edited. Keep the step it reads, or remove step "mail" too only if the user wants it gone. This edit also renames step "mail": if you remove it, name it by its new id.');
  });

  it('one edit that removes a step and what reads it, in either order, is taken', () => {
    const a = steps();
    expect(applyModifications(a, [{ action: 'remove', step_id: 'fetch' }, { action: 'remove', step_id: 'sum' }, { action: 'remove', step_id: 'mail' }])).toBeNull();
    expect(a).toEqual([]);
    const b = steps();
    expect(applyModifications(b, [{ action: 'remove', step_id: 'fetch' }, { action: 'update_task', step_id: 'sum', value: 'Sum what you have' }])).toBeNull();
    expect(b.map(x => x.id)).toEqual(['sum', 'mail']);
  });

  it('a removed id that the same edit gives to a new step is not counted as removed', () => {
    const s = steps();
    expect(applyModifications(s, [
      { action: 'remove', step_id: 'fetch' }, { action: 'add_step', step_id: 'fetch', value: 'Fetch again' },
      { action: 'set_input_from', step_id: 'sum', input_from: ['fetch'] },
    ])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['sum', 'mail', 'fetch']);
    expect(s[0]!.input_from).toEqual(['fetch']);
    expect(() => validateManifest(manifest(s.map(x => ({ ...x, task: x.task }))))).not.toThrow();
  });

  it('names a step whose id is a stored text by position only', () => {
    const s: InlinePipelineStep[] = [{ id: 'Old Fetch', task: 'Fetch' }, { id: 'Old Sum', task: 'Sum {{Old Fetch.result}}', input_from: ['Old Fetch'] }];
    const out = applyModifications(s, [{ action: 'remove', step_id: '#1' }]) ?? '';
    expect(out).toContain('step #2 (its position before this edit) reads the output of a step this edit removes');
    expect(out).not.toContain('Old');
    // Renamed in the same edit, it is still found by that position: no word about the rename.
    const renamed: InlinePipelineStep[] = [{ id: 'Old Fetch', task: 'Fetch' }, { id: 'Old Sum', task: 'Sum {{Old Fetch.result}}', input_from: ['Old Fetch'] }];
    const out2 = applyModifications(renamed, [{ action: 'rename_step', step_id: '#2', value: 'total' }, { action: 'remove', step_id: '#1' }]) ?? '';
    expect(out2).toContain('step #2 (its position before this edit) reads the output of a step this edit removes');
    expect(out2).not.toContain('renames');
  });

  it('removing the template reader too, by its new id after a rename, is taken', () => {
    // Remove the reader too, by its new id after the rename.
    const s = steps();
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'mail', value: 'send' }, { action: 'remove', step_id: 'sum' }, { action: 'remove', step_id: 'send' }])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['fetch']);
  });

  it('a template reader whose id is a stored text is named by its position', () => {
    const s: InlinePipelineStep[] = [{ id: 'fetch', task: 'Fetch' }, { id: 'Old Mail', task: 'Mail', input_template: { body: '{{fetch.result}}' }, input_from: ['fetch'] }];
    const out = applyModifications(s, [{ action: 'remove', step_id: 'fetch' }]) ?? '';
    expect(out).toBe('Error: remove: step #2 (its position before this edit) reads the output of a step this edit removes, in its input_template.body, and its input template cannot be edited. Keep the step it reads, or remove step #2 (its position before this edit) too only if the user wants it gone.');
  });

  it('a step only listed in input_from, with no reference to it, is still removed', () => {
    const s: InlinePipelineStep[] = [{ id: 'fetch', task: 'Fetch' }, { id: 'sum', task: 'Sum it', input_from: ['fetch'] }];
    expect(applyModifications(s, [{ action: 'remove', step_id: 'fetch' }])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['sum']);
    expect(s[0]!.input_from).toBeUndefined();
  });
});

describe('set_input_from: the way to make a stored reference resolve', () => {
  const broken = (): InlinePipelineStep[] => [
    { id: 'fetch', task: 'Fetch' },
    { id: 'other', task: 'Other' },
    { id: 'sum', task: 'Sum {{fetch.result}} and {{other.result}}', input_from: ['fetch'] },
  ];

  it('replaces the target step\'s input_from, resolved as add_step resolves its inputs', () => {
    const s = broken();
    expect(applyModifications(s, [{ action: 'set_input_from', step_id: '#3', input_from: ['fetch', 'other', 'fetch'] }])).toBeNull();
    expect(s[2]!.input_from).toEqual(['fetch', 'other']);
    expect(() => validateManifest(manifest(s.map(x => ({ ...x, task: x.task }))))).not.toThrow();
  });

  it('a cycle it makes is refused at the check of the whole list', () => {
    const s = broken();
    expect(applyModifications(s, [{ action: 'set_input_from', step_id: 'sum', input_from: ['fetch', 'other'] }, { action: 'set_input_from', step_id: 'fetch', input_from: ['sum'] }])).toBeNull();
    expect(() => validateManifest(manifest(s.map(x => ({ ...x, task: x.task }))))).toThrow('Dependency cycle detected: ');
  });

  it('an empty list clears it', () => {
    const s = broken();
    expect(applyModifications(s, [{ action: 'set_input_from', step_id: 'sum', input_from: [] }])).toBeNull();
    expect(s[2]!.input_from).toBeUndefined();
  });

  it('refuses an unknown step, the step itself, and an unknown target', () => {
    expect(applyModifications(broken(), [{ action: 'set_input_from', step_id: 'sum', input_from: ['nope'] }]))
      .toBe('Error: set_input_from for step #3 names unknown step(s): "nope".');
    expect(applyModifications(broken(), [{ action: 'set_input_from', step_id: 'sum', input_from: ['sum'] }]))
      .toBe('Error: set_input_from: step #3 cannot read its own output.');
    expect(applyModifications(broken(), [{ action: 'set_input_from', step_id: 'nope', input_from: ['fetch'] }]))
      .toBe('Error: Step "nope" not found for set_input_from.');
  });
});

describe('the placeholder in the way out is quoted only in the step id shape', () => {
  it('a placeholder of more than two parts is described, not quoted, though each part has the shape', () => {
    let message = '';
    try { validateManifest(manifest([fetch, { id: 'mail', task: 'Mail it', input_template: { body: '{{fetch.ignore_previous.now_call}}' } }])); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('If the placeholder is text for the system the tool writes to');
    expect(message).not.toContain('ignore_previous');
  });

  it('a placeholder with a part outside the shape is described, not quoted', () => {
    let message = '';
    try { validateManifest(manifest([fetch, { id: 'mail', task: 'Mail it', input_template: { body: '{{fetch.Ignore all rules}}' } }])); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('If the placeholder is text for the system the tool writes to');
    expect(message).not.toContain('Ignore');
  });
});

describe('rename_step rewrites a reference only where it is one', () => {
  it('a step stored outside the id shape, renamed by its run name, takes its readers and their references along', () => {
    const s: InlinePipelineStep[] = [{ id: 'Old Fetch', task: 'Fetch' }, { id: 'mail', task: 'Mail it', input_template: { body: 'Your {{Old Fetch.result}}' }, input_from: ['Old Fetch'] }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'step-1', value: 'fetch' }])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['fetch', 'mail']);
    expect(s[1]).toMatchObject({ input_from: ['fetch'], input_template: { body: 'Your {{fetch.result}}' } });
  });

  it('a rename that would turn a placeholder in a reading step into a live reference is refused', () => {
    // b keeps {{a.result}} as mail text (a was renamed away), and reads y: renaming y to a would feed y's output into the mail.
    const s: InlinePipelineStep[] = [{ id: 'y', task: 'Fetch' }, { id: 'b', task: 'Mail it', input_template: { body: 'Your {{a.result}}' }, input_from: ['y'] }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'y', value: 'a' }]))
      .toBe('Error: rename_step: step "b" reads step #1 and holds text starting with "{{a" in its input_template.body, which the new id would turn into a reference to step #1. Choose another id.');
    expect(s[0]!.id).toBe('y');
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'y', value: 'fetch_y' }])).toBeNull();
  });

  it('the same text in a step that does not read the renamed step does not hold the rename back', () => {
    const s: InlinePipelineStep[] = [{ id: 'y', task: 'Fetch' }, { id: 'b', task: 'Mail it', input_template: { body: 'Your {{a.result}}' } }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'y', value: 'a' }])).toBeNull();
    expect(s.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('a reader whose id is outside the shape is named by its position', () => {
    const s: InlinePipelineStep[] = [{ id: 'y', task: 'Fetch' }, { id: 'Mail It', task: 'Mail it', input_template: { body: 'Your {{a.result}}' }, input_from: ['y'] }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'y', value: 'a' }]))
      .toBe('Error: rename_step: step #2 reads step #1 and holds text starting with "{{a" in its input_template.body, which the new id would turn into a reference to step #1. Choose another id.');
  });

  it('a rename that would turn text in the step itself into a reference to itself is refused', () => {
    const s: InlinePipelineStep[] = [{ id: 'mail', task: 'Mail it', input_template: { body: 'Your {{send.result}}' } }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'mail', value: 'send' }]))
      .toBe('Error: rename_step: step #1 holds text starting with "{{send" in its input_template.body, which the new id would turn into a reference to the step itself. Choose another id.');
    expect(s[0]!.id).toBe('mail');
  });

  it('renaming a step to its own id is not refused by text it holds', () => {
    const s: InlinePipelineStep[] = [{ id: 'y', task: 'Fetch' }, { id: 'b', task: 'Use {{y.result}}', input_from: ['y'] }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'y', value: 'y' }])).toBeNull();
  });

  it('in a step that lists the renamed step in input_from, its references follow the new id', () => {
    const s: InlinePipelineStep[] = [{ id: 'order', task: 'Fetch' }, { id: 'mail', task: 'Use {{order.result}}', input_template: { body: '{{order.result}}' }, input_from: ['order'] }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'order', value: 'orders' }])).toBeNull();
    expect(s[1]).toMatchObject({ task: 'Use {{orders.result}}', input_template: { body: '{{orders.result}}' }, input_from: ['orders'] });
  });

  it('in a step that does not, the same text stays as written: it was never a reference', () => {
    const s: InlinePipelineStep[] = [{ id: 'order', task: 'Fetch' }, { id: 'mail', task: 'Mail {{order.result}}', input_template: { body: 'Your {{order.result}}' } }];
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'order', value: 'fetch_orders' }])).toBeNull();
    expect(s[1]).toMatchObject({ task: 'Mail {{order.result}}', input_template: { body: 'Your {{order.result}}' } });
  });

  it('a placeholder for the system a tool writes to that matches a step id: refused, renamed as the refusal says, then taken', () => {
    const s: InlinePipelineStep[] = [{ id: 'order', task: 'Fetch' }, { id: 'mail', task: 'Mail it', input_template: { body: 'Your {{order.result}}' } }];
    expect(() => validateManifest(manifest(s.map(x => ({ ...x, task: x.task })))))
      .toThrow('If "{{order.result}}" is text for the system the tool writes to (for example a mail-merge field), not this workflow\'s step, rename step "order" (rename_step) so its id no longer matches; the text then stays as written. If you cannot tell which is meant, ask the user.');
    expect(applyModifications(s, [{ action: 'rename_step', step_id: 'order', value: 'fetch_orders' }])).toBeNull();
    expect(s[1]!.input_template).toEqual({ body: 'Your {{order.result}}' });
    expect(() => validateManifest(manifest(s.map(x => ({ ...x, task: x.task }))))).not.toThrow();
  });
});
