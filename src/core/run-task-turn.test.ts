import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compose } from './data-boundary.js';
import { runTaskPrompt, runTaskTitle, RUN_TASK_LEAD } from './run-task-turn.js';

describe('a scheduled run\'s opening turn', () => {
  it('runTaskTitle reads the task\'s title out of the run\'s turn, and nothing out of any other text', () => {
    expect(runTaskTitle(compose(runTaskPrompt('Daily Report', 'Generate it'), '\n'))).toBe('Daily Report');
    expect(runTaskTitle(compose(runTaskPrompt('Daily Report', undefined), '\n'))).toBe('Daily Report');
    expect(runTaskTitle(`[Now: 2026-11-05T09:00:00.000Z; user local 2026-11-05 10:00:00 Europe/Zurich]\n\n${compose(runTaskPrompt('Daily Report', 'Generate it'), '\n')}`)).toBe('Daily Report');
    expect(runTaskTitle(`Hi. ${RUN_TASK_LEAD}`)).toBeNull();
    expect(runTaskTitle('Task: Daily Report')).toBeNull();
    // Any other text, however long, names no task.
    expect(runTaskTitle(`${'An owner message that is long enough to reach past the lead. '.repeat(4)}\nSecond line`)).toBeNull();
    expect(runTaskTitle(`${RUN_TASK_LEAD}\n<scheduled_task>\nTask: \n</scheduled_task>`)).toBeNull();
  });

  it('the web-ui carries byte-identical copies of the engine\'s three sentences', () => {
    // The web-ui cannot import across the package boundary; it recognises a run's turn only by
    // these exact sentences. A drift would show the turn as the owner's bubble again.
    const decl = (path: string, name: string): string => {
      const m = new RegExp(`^export const ${name} = .+$`, 'm').exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
      expect(m, `no ${name} declaration in ${path}`).not.toBeNull();
      return m![0];
    };
    const webUi = '../../packages/web-ui/src/lib/utils/scheduled-task-turn.ts';
    for (const name of ['RUN_TASK_LEAD', 'RUN_TASK_ANSWERED', 'RUN_TASK_ANSWER_PREAMBLE']) {
      expect(decl(webUi, name)).toBe(decl('./run-task-turn.ts', name));
    }
  });
});
