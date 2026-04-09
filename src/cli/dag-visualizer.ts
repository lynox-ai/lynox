import type { InlinePipelineStep } from '../types/index.js';
import { GREEN, RED, BLUE, DIM, RESET, BOLD } from './ansi.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cached';

const STATUS_ICONS: Record<StepStatus, string> = {
  pending: '\u25CB',  // ○
  running: '\u25C9',  // ◉
  done:    '\u2713',  // ✓
  failed:  '\u2717',  // ✗
  skipped: '\u2298',  // ⊘
  cached:  '\u21BA',  // ↺
};

function colorize(status: StepStatus, text: string): string {
  switch (status) {
    case 'done':    return `${GREEN}${text}${RESET}`;
    case 'failed':  return `${RED}${text}${RESET}`;
    case 'running': return `${BLUE}${text}${RESET}`;
    case 'skipped': return `${DIM}${text}${RESET}`;
    case 'cached':  return `${DIM}${text}${RESET}`;
    case 'pending': return text;
    default:        return text;
  }
}

export interface DagVisualizerOptions {
  pipelineName?: string | undefined;
  isTTY?: boolean | undefined;
}

export class DagVisualizer {
  private readonly steps: InlinePipelineStep[];
  private readonly phases: string[][];
  private readonly statuses: Map<string, StepStatus>;
  private readonly name: string;
  private readonly isTTY: boolean;
  private lastLineCount = 0;

  constructor(steps: InlinePipelineStep[], options?: DagVisualizerOptions) {
    this.steps = steps;
    this.name = options?.pipelineName ?? 'pipeline';
    this.isTTY = options?.isTTY ?? true;
    this.statuses = new Map();
    for (const s of steps) {
      this.statuses.set(s.id, 'pending');
    }
    this.phases = this._computePhases();
  }

  private _computePhases(): string[][] {
    const phases: string[][] = [];
    const resolved = new Set<string>();
    const remaining = [...this.steps];

    while (remaining.length > 0) {
      const ready = remaining.filter(s =>
        !s.input_from?.length || s.input_from.every(dep => resolved.has(dep)),
      );
      if (ready.length === 0) break;
      phases.push(ready.map(s => s.id));
      for (const s of ready) resolved.add(s.id);
      remaining.splice(0, remaining.length, ...remaining.filter(s => !resolved.has(s.id)));
    }

    return phases;
  }

  updateStatus(stepId: string, status: StepStatus): void {
    this.statuses.set(stepId, status);
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`${BOLD}Pipeline: ${this.name}${RESET}`);
    lines.push('');

    for (let i = 0; i < this.phases.length; i++) {
      const phase = this.phases[i]!;
      const stepParts = phase.map(id => {
        const status = this.statuses.get(id) ?? 'pending';
        const icon = STATUS_ICONS[status];
        return colorize(status, `[ ${id} ${icon} ]`);
      });

      lines.push(`Phase ${i}  ${stepParts.join('  ')}`);

      // Draw connectors to next phase
      if (i < this.phases.length - 1) {
        const nextPhase = this.phases[i + 1]!;
        const hasConnection = nextPhase.some(nextId => {
          const step = this.steps.find(s => s.id === nextId);
          return step?.input_from?.some(dep => phase.includes(dep));
        });
        if (hasConnection) {
          // Simple connector
          const padding = ' '.repeat(10);
          lines.push(`${padding}${DIM}|${RESET}`);
        }
      }
    }

    return lines.join('\n');
  }

  /** Render with in-place update (TTY only) */
  renderInPlace(stream: NodeJS.WritableStream): void {
    if (!this.isTTY) {
      // Non-TTY fallback: just print the current state
      stream.write(this.render() + '\n');
      return;
    }

    // Clear previous output
    if (this.lastLineCount > 0) {
      stream.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
    }

    const output = this.render();
    stream.write(output + '\n');
    this.lastLineCount = output.split('\n').length;
  }
}
