import type { ToolEntry, IAgent } from '../../types/index.js';

interface AskSecretInput {
  name: string;
  prompt: string;
  key_type?: string | undefined;
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const askSecretTool: ToolEntry<AskSecretInput> = {
  definition: {
    name: 'ask_secret',
    description:
      'Securely collect a secret (API key, token, password) from the user. ' +
      'The secret is stored encrypted in the vault and NEVER enters the conversation. ' +
      'Use this instead of ask_user whenever the answer is a credential.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Vault key name in UPPER_SNAKE_CASE (e.g. STRIPE_API_KEY, GITHUB_TOKEN). ' +
            'Must start with a letter, only A-Z, 0-9, underscore. Max 64 chars.',
        },
        prompt: {
          type: 'string',
          description: 'Human-readable prompt shown to the user (e.g. "Enter your Stripe API key")',
        },
        key_type: {
          type: 'string',
          description:
            'Optional key type hint for client-side prefix validation. ' +
            'Examples: "stripe" (sk_live_/sk_test_), "openai" (sk-), "github" (ghp_/gho_/ghs_)',
        },
      },
      required: ['name', 'prompt'],
    },
  },
  handler: async (input: AskSecretInput, agent: IAgent): Promise<string> => {
    if (!NAME_PATTERN.test(input.name)) {
      return `Error: Invalid secret name "${input.name}". Must be UPPER_SNAKE_CASE (A-Z, 0-9, _), start with a letter, max 64 chars.`;
    }

    if (!agent.promptSecret) {
      return 'Secure secret input is not available in this context. Ask the user to enter the key in Settings → API Keys instead.';
    }

    const saved = await agent.promptSecret(input.name, input.prompt, input.key_type);

    if (!saved) {
      return `User canceled the secret prompt for "${input.name}".`;
    }

    return `Secret "${input.name}" saved securely in the vault. Use secret:${input.name} to reference it.`;
  },
};
