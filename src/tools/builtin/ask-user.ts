import type { ToolEntry, IAgent, TabQuestion, StepHint } from '../../types/index.js';

/** An option can be a plain string or an object with an optional StepHint. */
type AskUserOption = string | { label: string; hint?: StepHint | undefined };

interface AskUserInput {
  question?: string | undefined;
  options?: AskUserOption[] | undefined;
  questions?: Array<{ question: string; header?: string; options?: AskUserOption[] }> | undefined;
  /** Single-question only: let the user pick MULTIPLE options (toggle + Send)
   *  instead of one-click-and-done. The answer comes back as a comma-joined
   *  list of the chosen labels. Use when several options can legitimately apply
   *  at once. Ignored for the `questions` batch form. */
  multiSelect?: boolean | undefined;
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
    description: 'Ask the user one or more questions and wait for their response. Provide EITHER `question` (a single question) OR `questions` (a batch shown as tabs) — not both. ALWAYS provide `options` when the set of possible answers is finite (e.g., yes/no, a list of files, deployment targets). Free-text only when the answer is truly open-ended.',
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
                      model: { type: 'string', enum: ['deep', 'balanced', 'fast'], description: 'Preferred capability tier (fast/balanced/deep)' },
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
        multiSelect: {
          type: 'boolean',
          description: 'Single-question only: allow the user to select MULTIPLE options (they toggle several, then press Send) instead of one-click. Use when several options can apply at once. Default false.',
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
                            model: { type: 'string', enum: ['deep', 'balanced', 'fast'] },
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
      // Neither field is hard-required at the schema level: a call is valid
      // with `question` OR `questions`. The handler enforces "at least one"
      // with an actionable message — the old `required: ['question']` made
      // questions-only batches fail with a cryptic schema error.
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
      // Prefer tabbed dialog (CLI/PWA), fall back to sequential prompts for transports without tab UI
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

    // Single-question path: reached only when no `questions` batch was given,
    // so `question` must be present here.
    const question = input.question;
    if (typeof question !== 'string' || question.trim() === '') {
      throw new Error('ask_user: provide either `question` (a single question) or a non-empty `questions` array.');
    }

    const labels = input.options && input.options.length > 0 ? [...toLabels(input.options), '\x00'] : undefined;
    // Only pass the meta arg in the multi-select case so single-select calls
    // stay byte-identical to before (2 args) — no back-compat surprise.
    const answer = input.multiSelect
      ? await agent.promptUser(question, labels, { multiSelect: true })
      : await agent.promptUser(question, labels);

    // Multi-select answers come back as a JSON-encoded string[] of labels.
    // Present them to the model as a clean comma-joined list; a step hint only
    // applies when exactly one option was chosen (hints are single-choice).
    if (input.multiSelect && answer !== '__dismissed__') {
      let selected: string[] | null = null;
      try {
        const parsed = JSON.parse(answer) as unknown;
        if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) selected = parsed as string[];
      } catch { /* not JSON — a legacy single-select client; fall through */ }
      if (selected) {
        if (selected.length === 1) {
          const hint = findHint(input.options, selected[0]!);
          if (hint) agent.toolContext.pendingStepHint = hint;
        }
        return selected.length > 0 ? selected.join(', ') : '__dismissed__';
      }
    }

    // Store hint for selected option (applied at next session.run())
    const hint = findHint(input.options, answer);
    if (hint) {
      agent.toolContext.pendingStepHint = hint;
    }

    return answer;
  },
};
