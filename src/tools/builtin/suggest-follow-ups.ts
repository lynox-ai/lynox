import type { ToolEntry, IAgent } from '../../types/index.js';

interface FollowUpSuggestion {
  label: string;
  task: string;
}

interface SuggestFollowUpsInput {
  suggestions?: FollowUpSuggestion[] | undefined;
}

/**
 * Terminal tool that emits end-of-turn follow-up suggestion chips for the Web UI.
 *
 * The suggestions ARE the tool input — the Web UI renders them as clickable pills
 * directly from the `tool_call` stream event (live) and from the persisted
 * `tool_use` block (thread resume). This replaces the older `<follow_ups>` text
 * block, which leaked as raw JSON whenever a model emitted it without the wrapper
 * or followed it with trailing prose.
 *
 * `endsTurn: true` — the agent loop returns the turn's text right after this
 * tool_result instead of making another full-context model call (the tool has
 * nothing more to say). The Web-UI system-prompt suffix is what instructs the
 * model to call it; on other surfaces (CLI/headless) the tool is registered but
 * never prompted, so it stays dormant.
 *
 * The handler is a no-op acknowledgement: nothing is persisted or dispatched
 * server-side beyond the tool_use/tool_result pair itself. Input is untrusted
 * only in the benign sense that a prompt-injected caller could end a turn early
 * or supply chip text — the pill click is the consent gate, and the tool touches
 * no secret, network, or stored state.
 */
export const suggestFollowUpsTool: ToolEntry<SuggestFollowUpsInput> = {
  endsTurn: true,
  definition: {
    name: 'suggest_follow_ups',
    description:
      'Web UI only. Emit end-of-turn follow-up chips (2-4). Terminal — ENDS your turn; ' +
      'call it last. See the Web UI Mode instructions for when and how.',
    input_schema: {
      type: 'object' as const,
      properties: {
        suggestions: {
          type: 'array',
          description: 'Up to 4 follow-up suggestions.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Chip label, ≤40 chars.' },
              task: { type: 'string', description: 'Self-contained instruction run when clicked.' },
            },
            required: ['label', 'task'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
  handler: async (input: SuggestFollowUpsInput, _agent: IAgent): Promise<string> => {
    const count = Array.isArray(input.suggestions)
      ? input.suggestions.filter(
          s => s && typeof s.label === 'string' && s.label.trim().length > 0
            && typeof s.task === 'string' && s.task.trim().length > 0,
        ).length
      : 0;
    // The Web UI renders the chips from the tool input; this ack just closes the
    // tool_use/tool_result pair. No side effects.
    return count > 0
      ? `Presented ${count} follow-up suggestion${count === 1 ? '' : 's'}.`
      : 'No follow-up suggestions presented.';
  },
};
