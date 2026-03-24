import type { ToolEntry, IAgent, TabQuestion } from '../../types/index.js';

interface AskUserInput {
  question: string;
  options?: string[] | undefined;
  questions?: Array<{ question: string; header?: string; options?: string[] }> | undefined;
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
          items: { type: 'string' },
          description: 'Choices for the user to select from. STRONGLY PREFERRED over free-text — include 2-5 clear, distinct options. Examples: ["Yes", "No"], ["Staging", "Production", "Both"], ["Fix and retry", "Skip this file", "Abort"]',
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
                items: { type: 'string' },
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

    if (input.questions && input.questions.length > 0) {
      // Prefer tabbed dialog (CLI), fall back to sequential prompts (Slack/MCP)
      if (agent.promptTabs) {
        const tabQuestions: TabQuestion[] = input.questions.map(q => ({
          question: q.question,
          header: q.header,
          options: q.options,
        }));
        const answers = await agent.promptTabs(tabQuestions);
        if (answers.length === 0) return 'User canceled.';
        return answers.map((a, i) => `${input.questions![i]!.question}: ${a}`).join('\n');
      }
      // Sequential fallback: ask each question one at a time
      const answers: string[] = [];
      for (const q of input.questions) {
        const opts = q.options && q.options.length > 0 ? [...q.options, '\x00'] : q.options;
        const answer = await agent.promptUser(q.question, opts);
        answers.push(answer);
      }
      return answers.map((a, i) => `${input.questions![i]!.question}: ${a}`).join('\n');
    }

    const opts = input.options && input.options.length > 0 ? [...input.options, '\x00'] : input.options;
    return agent.promptUser(input.question, opts);
  },
};
