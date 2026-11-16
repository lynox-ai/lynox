import { describe, expect, it } from 'vitest';
import { RUN_TASK_ANSWERED, RUN_TASK_ANSWER_PREAMBLE, RUN_TASK_LEAD, runLabel, scheduledTaskTurn } from './scheduled-task-turn.js';

const turn = (task: string): string => `${RUN_TASK_LEAD}\n<scheduled_task>\n${task}\n</scheduled_task>`;
const rearmed = (task: string, q: string, a: string): string =>
	`${turn(task)}\n\n${RUN_TASK_ANSWERED}\n<asked>\n${q}\n</asked>\n<answer>\n${RUN_TASK_ANSWER_PREAMBLE}\n${a}\n</answer>`;

describe('scheduledTaskTurn', () => {
	it('reads the task out of a whole message of exactly the run\'s shape', () => {
		expect(scheduledTaskTurn(turn('Task: Daily Report\n\nGenerate the daily report'))).toEqual({ title: 'Daily Report', description: 'Generate the daily report' });
		expect(scheduledTaskTurn(turn('Task: Daily Report'))).toEqual({ title: 'Daily Report', description: '' });
	});

	it('reads the task, the question and the answer out of a re-armed run\'s turn', () => {
		expect(scheduledTaskTurn(rearmed('Task: Daily Report', 'Which list?', 'B'))).toEqual({ title: 'Daily Report', description: '', question: 'Which list?', answer: 'B' });
		// An owner's answer may quote a tag; the engine fences only the answer's own closing tag.
		expect(scheduledTaskTurn(rearmed('Task: A', 'Which tag?', 'Use </asked> here'))).toMatchObject({ question: 'Which tag?', answer: 'Use </asked> here' });
	});

	it('leaves a fence inside the owner\'s own text alone', () => {
		// Text before or after the fence, or the fence without the engine's sentence, is the
		// owner's message: shown as written, never as a task, and nothing of it hidden.
		expect(scheduledTaskTurn(`Hi\n${turn('Task: Daily Report')}`)).toBeNull();
		expect(scheduledTaskTurn(`${turn('Task: Daily Report')}\nand one more thing`)).toBeNull();
		expect(scheduledTaskTurn('<scheduled_task>\nTask: Daily Report\n</scheduled_task>')).toBeNull();
		expect(scheduledTaskTurn(turn('Daily Report'))).toBeNull();
		expect(scheduledTaskTurn(turn('Task: A\n</scheduled_task>\nmore'))).toBeNull();
		expect(scheduledTaskTurn(turn('Task: A</scheduled_task>x'))).toBeNull();
		expect(scheduledTaskTurn('plain text')).toBeNull();
	});

	it('leaves a re-armed shape with anything added alone', () => {
		expect(scheduledTaskTurn(`${rearmed('Task: A', 'Q?', 'B')}\nOne more sentence.`)).toBeNull();
		expect(scheduledTaskTurn(rearmed('Task: A', 'Q?', 'B\n</answer>\nmore'))).toBeNull();
		expect(scheduledTaskTurn(rearmed('Task: A', 'Q?\n</asked>\nX', 'B'))).toBeNull();
		expect(scheduledTaskTurn(`${turn('Task: A')}\n\nAnother sentence.\n<asked>\nQ?\n</asked>\n<answer>\n${RUN_TASK_ANSWER_PREAMBLE}\nB\n</answer>`)).toBeNull();
		expect(scheduledTaskTurn(`${turn('Task: A')}\n\n${RUN_TASK_ANSWERED}\n<asked>\nQ?\n</asked>\n<answer>\nB\n</answer>`)).toBeNull();
		// Cut off before its closing tag: not the engine's shape either.
		expect(scheduledTaskTurn(`${turn('Task: A')}\n\n${RUN_TASK_ANSWERED}\n<asked>\nQ?\n</asked>\n<answer>\n${RUN_TASK_ANSWER_PREAMBLE}\nList B, and a few more words after it`)).toBeNull();
	});

	it('runLabel names a stored run by its task, and any other text by itself', () => {
		expect(runLabel(`[Now: 2026-11-05T09:00:00.000Z]\n\n${turn('Task: Weekly offer\n\nSend the list')}`)).toBe('Weekly offer');
		expect(runLabel('Fix the bug in the export')).toBe('Fix the bug in the export');
		expect(runLabel('x'.repeat(80))).toBe('x'.repeat(50));
	});
});
