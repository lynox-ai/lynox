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
        // Post-2026-05-18 inversion: this outcome now ONLY fires for the
        // narrow set of admin-only infrastructure secrets (LYNOX_*, MAIL_
        // ACCOUNT_*, GOOGLE_OAUTH_*, SMTP_*, IMAP_*, etc.) —
        // generic integration keys (SHOPIFY_*, STRIPE_*, etc.) are now
        // user-writable on managed by default. So the agent should
        // explain "this specific name maps to engine/channel infrastructure
        // — use the relevant integration UI instead", NOT "your tier is
        // restricted from integrations". The template below is a SHAPE,
        // not literal copy — translate to the user's language; the rules
        // that follow are instructions the user must NEVER see.
        return `The vault rejected "${input.name}" because this name maps to engine or channel infrastructure (mail-account / OAuth / engine-internal credentials), which is managed by the platform — not by the agent or the end-user. Reply to the user in their language (NOT this template language) — paraphrase the shape below:
> "Diesen Schlüssel kannst du nicht direkt setzen — er wird automatisch verwaltet (z.B. Mail-Konten über die Mail-Einstellungen, OAuth über die jeweilige Integration). Wenn du eine bestimmte Integration aktivieren willst, sag mir welche — ich kann dir den richtigen Weg dorthin zeigen."

Reply rules — these are instructions for the agent, NOT content for the user:
1. Translate to the user's language first. The German example above is a SHAPE.
2. Don't lecture about tiers, allowlists, or the managed-vs-self-host distinction — that's no longer the gating axis. The gating axis is "infrastructure secret" vs "integration secret you bring".
3. If the user clearly wanted an INTEGRATION (e.g. they asked about Shopify, Stripe, DataForSEO), the name was probably wrong — propose a corrected name (e.g. SHOPIFY_ACCESS_TOKEN, STRIPE_API_KEY) and retry \`ask_secret\` with that name. Integration secrets pass without gating; only the specific name was misaligned with the platform's infrastructure namespace.
4. If the user genuinely needs an infrastructure key set (rare — should never be an agent-initiated request), direct them to the relevant integration UI: Mail accounts → mail settings, Google → Google OAuth flow, etc.
5. Do NOT retry the secret tool with the SAME admin-only name — try a different (integration-flavoured) name if you suspect misalignment, but admin-only names will keep failing.
6. Do NOT propose a plaintext fallback in any form (chat paste, DM, "tell me as text") — the vault is the only path for any secret, full stop.`;

      case 'vault_error':
        // Distinct from user-cancel: the user submitted but the server
        // couldn't persist. Likely transient — let the model offer a retry.
        return `Vault write failed for "${input.name}" — this is a server-side error, NOT a user cancel. Tell the user the secret could not be stored, and ask if they want to retry. If retry also fails, escalate. DO NOT offer a plaintext fallback.`;
    }
  },
};
