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
      return 'Secure secret input is not available in this context. Ask the user to enter the key in Settings → API Keys instead. Do NOT ask the user to paste the secret into chat.';
    }

    const outcome = await agent.promptSecret(input.name, input.prompt, input.key_type);

    switch (outcome) {
      case 'saved':
        return `Secret "${input.name}" saved securely in the vault. Use secret:${input.name} to reference it.`;

      case 'canceled':
        // Hard guard against the failure mode that prompted this refactor:
        // the model used to follow a cancel with "want to send it as text
        // instead?", leaking credentials into chat history. The tool result
        // now spells out the contract for the next decision.
        return `User canceled the secret prompt for "${input.name}". Acknowledge briefly and stop. DO NOT offer a plaintext fallback (no "tell me as text", "paste in chat", "send via DM"). The vault flow is the only way to submit credentials. If the task can't continue without this secret, ask the user once whether they want to retry; otherwise move on.`;

      case 'managed_blocked':
        // Managed-tier write allowlist (BYOK_USER_WRITABLE_SECRETS) only
        // permits the LLM provider keys. Tool/integration keys 403. The
        // model must not retry the same name and must not propose to
        // receive the secret directly. The template below is a SHAPE,
        // not literal copy — agent translates to the user's language;
        // the rules that follow are instructions the user must NEVER see.
        return `The vault rejected "${input.name}" because this integration's secret isn't user-installable on the current managed plan. Reply to the user in their language (NOT this template language) — paraphrase the shape below:
> "This integration isn't self-installable on your managed plan today. Two ways forward: (a) email support@lynox.ai — we'll enable it admin-side on your instance, or (b) self-host lynox for full control over all integrations."

Reply rules — these are instructions for the agent, NOT content for the user:
1. Translate to the user's language first. If the user has been writing in German, reply in German. In French, reply in French. The English template above is a SHAPE — never echo it verbatim.
2. Don't explain WHY it was blocked. Don't reference internal mechanisms, naming schemes, or which categories of secrets are allowed. The user doesn't need the implementation reason — just the path forward.
3. Keep the reply tight (2-3 sentences). Don't justify the policy, just give the two paths.
4. Do NOT retry the secret tool with the same name.
5. Do NOT propose a plaintext fallback in any form (chat paste, DM, "tell me as text") — the vault is the only path, full stop.`;

      case 'vault_error':
        // Distinct from user-cancel: the user submitted but the server
        // couldn't persist. Likely transient — let the model offer a retry.
        return `Vault write failed for "${input.name}" — this is a server-side error, NOT a user cancel. Tell the user the secret could not be stored, and ask if they want to retry. If retry also fails, escalate. DO NOT offer a plaintext fallback.`;
    }
  },
};
