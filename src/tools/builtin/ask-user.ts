import type { ToolEntry, IAgent, TabQuestion, StepHint } from '../../types/index.js';

/** An option can be a plain string or an object with an optional StepHint. */
type AskUserOption = string | { label: string; hint?: StepHint | undefined };

interface AskUserInput {
  question: string;
  options?: AskUserOption[] | undefined;
  questions?: Array<{ question: string; header?: string; options?: AskUserOption[] }> | undefined;
}

/** Extract display label from a plain string or option object. */
function optionLabel(opt: AskUserOption): string {
  return typeof opt === 'string' ? opt : opt.label;
}

/** Find the StepHint for a selected label within options. */
function findHint(options: AskUserOption[] | undefined, selectedLabel: string): StepHint | undefined {
  if (!options) return undefined;
  for (const opt of options) {
    if (typeof opt !== 'string' && opt.label === selectedLabel && opt.hint) {
      return opt.hint;
    }
  }
  return undefined;
}

/** Convert AskUserOption[] to plain string[] for promptUser. */
function toLabels(options: AskUserOption[]): string[] {
  return options.map(optionLabel);
}

/**
 * Models occasionally emit a stringified tool-use payload (e.g. leaked
 * `<parameter name="options">…</parameter>` XML) instead of a real array.
 * Reject early with a clear message so the next turn can correct itself
 * instead of crashing inside `.map`.
 */
function assertOptionsArray(
  value: unknown,
  field: string,
): asserts value is AskUserOption[] | undefined {
  if (value === undefined || Array.isArray(value)) return;
  throw new Error(
    `ask_user: \`${field}\` must be an array of strings or { label, hint? } objects, got ${typeof value}. Retry the call with a proper JSON array.`,
  );
}

export const askUserTool: ToolEntry<AskUserInput> = {
  definition: {
    name: 'ask_user',
    description: 'Ask the user a question and wait for their response. ALWAYS provide `options` when the set of possible answers is finite (e.g., yes/no, a list of files, deployment targets). Free-text only when the answer is truly open-ended.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display text for this option' },
                  hint: {
                    type: 'object',
                    description: 'Configuration hint for the next step when this option is selected',
                    properties: {
                      model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Preferred model tier' },
                      thinking: { type: 'string', enum: ['adaptive', 'enabled', 'disabled'], description: 'Thinking mode' },
                      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Effort level' },
                    },
                  },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Choices for the user to select from. Each option can be a plain string or an object with { label, hint? } for step configuration.',
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text' },
              header: { type: 'string', description: 'Short tab label (defaults to Q1, Q2, ...)' },
              options: {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        hint: {
                          type: 'object',
                          properties: {
                            model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
                            thinking: { type: 'string', enum: ['adaptive', 'enabled', 'disabled'] },
                            effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                          },
                        },
                      },
                      required: ['label'],
                    },
                  ],
                },
                description: 'Optional choices for this question',
              },
            },
            required: ['question'],
          },
          description: 'Multiple questions shown as sequential tabs with navigation',
        },
      },
      required: ['question'],
    },
  },
  handler: async (input: AskUserInput, agent: IAgent): Promise<string> => {
    if (!agent.promptUser) {
      return 'Interactive input not available in this context.';
    }

    assertOptionsArray(input.options, 'options');
    if (input.questions) {
      // Bound to prevent UI overload + DoS via unbounded question arrays.
      // 20 is a soft cap — tabs UI becomes unusable well before that.
      const MAX_QUESTIONS = 20;
      if (input.questions.length > MAX_QUESTIONS) {
        throw new Error(`ask_user: \`questions\` has ${input.questions.length} entries (max ${MAX_QUESTIONS}). Split into smaller batches.`);
      }
      for (const [i, q] of input.questions.entries()) {
        assertOptionsArray(q.options, `questions[${i}].options`);
      }
    }

    if (input.questions && input.questions.length > 0) {
      // Prefer tabbed dialog (CLI), fall back to sequential prompts (Slack/MCP)
      if (agent.promptTabs) {
        const tabQuestions: TabQuestion[] = input.questions.map(q => ({
          question: q.question,
          header: q.header,
          options: q.options ? toLabels(q.options) : undefined,
        }));
        const answers = await agent.promptTabs(tabQuestions);
        if (answers.length === 0) return 'User canceled.';
        // Store hint from last answered question with a matching option
        for (let i = answers.length - 1; i >= 0; i--) {
          const hint = findHint(input.questions[i]?.options, answers[i]!);
          if (hint) {
            agent.toolContext.pendingStepHint = hint;
            break;
          }
        }
        return answers.map((a, i) => `${input.questions![i]!.question}: ${a}`).join('\n');
      }
      // Sequential fallback: ask each question one at a time
      const answers: string[] = [];
      for (const q of input.questions) {
        const labels = q.options && q.options.length > 0 ? [...toLabels(q.options), '\x00'] : undefined;
        const answer = await agent.promptUser(q.question, labels);
        // Store hint for this answer
        const hint = findHint(q.options, answer);
        if (hint) {
          agent.toolContext.pendingStepHint = hint;
        }
        answers.push(answer);
      }
      return answers.map((a, i) => `${input.questions![i]!.question}: ${a}`).join('\n');
    }

    const labels = input.options && input.options.length > 0 ? [...toLabels(input.options), '\x00'] : undefined;
    const answer = await agent.promptUser(input.question, labels);

    // Store hint for selected option (applied at next session.run())
    const hint = findHint(input.options, answer);
    if (hint) {
      agent.toolContext.pendingStepHint = hint;
    }

    return answer;
  },
};
