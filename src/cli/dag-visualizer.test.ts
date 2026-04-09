import { describe, it, expect } from 'vitest';
import { DagVisualizer } from './dag-visualizer.js';
import type { StepStatus } from './dag-visualizer.js';
import type { InlinePipelineStep } from '../types/index.js';

// ANSI codes used in the visualizer
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

describe('DagVisualizer', () => {
  it('constructor initializes all steps as pending', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'Task A' },
      { id: 'b', task: 'Task B' },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    // Pending icon is ○
    expect(output).toContain('a \u25CB');
    expect(output).toContain('b \u25CB');
  });

  it('updateStatus changes step status', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'Task A' },
    ];
    const viz = new DagVisualizer(steps);
    viz.updateStatus('a', 'done');
    const output = viz.render();
    // Done icon is ✓
    expect(output).toContain('a \u2713');
  });

  it('render() shows pipeline name', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'Task A' },
    ];
    const viz = new DagVisualizer(steps, { pipelineName: 'my-pipeline' });
    const output = viz.render();
    expect(output).toContain('Pipeline: my-pipeline');
  });

  it('render() shows correct phase grouping for linear topology (3 phases)', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'Task A' },
      { id: 'b', task: 'Task B', input_from: ['a'] },
      { id: 'c', task: 'Task C', input_from: ['b'] },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    // Each step should be in its own phase
    expect(output).toContain('Phase 0');
    expect(output).toContain('Phase 1');
    expect(output).toContain('Phase 2');
    // Verify ordering: a in phase 0, b in phase 1, c in phase 2
    const lines = output.split('\n');
    const phase0Line = lines.find(l => l.startsWith('Phase 0'));
    const phase1Line = lines.find(l => l.startsWith('Phase 1'));
    const phase2Line = lines.find(l => l.startsWith('Phase 2'));
    expect(phase0Line).toContain('a');
    expect(phase1Line).toContain('b');
    expect(phase2Line).toContain('c');
  });

  it('render() shows parallel steps in same phase (diamond topology)', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'Task A' },
      { id: 'b', task: 'Task B', input_from: ['a'] },
      { id: 'c', task: 'Task C', input_from: ['a'] },
      { id: 'd', task: 'Task D', input_from: ['b', 'c'] },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    // Phase 0: a, Phase 1: b + c (parallel), Phase 2: d
    const lines = output.split('\n');
    const phase1Line = lines.find(l => l.startsWith('Phase 1'));
    expect(phase1Line).toBeDefined();
    expect(phase1Line).toContain('b');
    expect(phase1Line).toContain('c');
  });

  it('render() shows status icons correctly for all statuses', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'done-step', task: 'T' },
      { id: 'failed-step', task: 'T' },
      { id: 'running-step', task: 'T' },
      { id: 'pending-step', task: 'T' },
      { id: 'skipped-step', task: 'T' },
      { id: 'cached-step', task: 'T' },
    ];
    const viz = new DagVisualizer(steps);
    viz.updateStatus('done-step', 'done');
    viz.updateStatus('failed-step', 'failed');
    viz.updateStatus('running-step', 'running');
    // pending-step stays pending
    viz.updateStatus('skipped-step', 'skipped');
    viz.updateStatus('cached-step', 'cached');

    const output = viz.render();
    expect(output).toContain('\u2713');  // done ✓
    expect(output).toContain('\u2717');  // failed ✗
    expect(output).toContain('\u25C9');  // running ◉
    expect(output).toContain('\u25CB');  // pending ○
    expect(output).toContain('\u2298');  // skipped ⊘
    expect(output).toContain('\u21BA');  // cached ↺
  });

  it('render() with single step', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'only', task: 'Only task' },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    expect(output).toContain('Phase 0');
    expect(output).toContain('only');
    // Should not have Phase 1
    expect(output).not.toContain('Phase 1');
  });

  it('render() with wide parallel (all steps in phase 0)', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'x', task: 'T' },
      { id: 'y', task: 'T' },
      { id: 'z', task: 'T' },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    // All three in phase 0
    const lines = output.split('\n');
    const phase0Line = lines.find(l => l.startsWith('Phase 0'));
    expect(phase0Line).toContain('x');
    expect(phase0Line).toContain('y');
    expect(phase0Line).toContain('z');
    // No phase 1
    expect(output).not.toContain('Phase 1');
  });

  it('renderInPlace for non-TTY outputs line-by-line', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'T' },
      { id: 'b', task: 'T', input_from: ['a'] },
    ];
    const viz = new DagVisualizer(steps, { isTTY: false });
    const chunks: string[] = [];
    const mockStream = {
      write: (data: string | Uint8Array) => {
        chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
        return true;
      },
    } as NodeJS.WritableStream;

    viz.renderInPlace(mockStream);
    const written = chunks.join('');
    // Should contain pipeline output ending with \n
    expect(written).toContain('Pipeline:');
    expect(written.endsWith('\n')).toBe(true);
    // Non-TTY should NOT contain cursor movement escape codes (e.g. \x1b[3A\x1b[0J)
    expect(written).not.toMatch(/\x1b\[\d+A/);
    expect(written).not.toMatch(/\x1b\[0J/);
  });

  it('ANSI colors: done is green, failed is red, running is blue', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'g', task: 'T' },
      { id: 'r', task: 'T' },
      { id: 'b', task: 'T' },
    ];
    const viz = new DagVisualizer(steps);
    viz.updateStatus('g', 'done');
    viz.updateStatus('r', 'failed');
    viz.updateStatus('b', 'running');

    const output = viz.render();
    // Green for done
    expect(output).toContain(`${GREEN}[ g \u2713 ]${RESET}`);
    // Red for failed
    expect(output).toContain(`${RED}[ r \u2717 ]${RESET}`);
    // Blue for running
    expect(output).toContain(`${BLUE}[ b \u25C9 ]${RESET}`);
  });

  it('default pipeline name is "pipeline"', () => {
    const steps: InlinePipelineStep[] = [{ id: 'a', task: 'T' }];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    expect(output).toContain('Pipeline: pipeline');
  });

  it('connectors appear between phases with dependencies', () => {
    const steps: InlinePipelineStep[] = [
      { id: 'a', task: 'T' },
      { id: 'b', task: 'T', input_from: ['a'] },
    ];
    const viz = new DagVisualizer(steps);
    const output = viz.render();
    // DIM connector pipe
    expect(output).toContain(`${DIM}|${RESET}`);
  });
});
