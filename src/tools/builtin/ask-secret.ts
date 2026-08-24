import type { ToolEntry, IAgent } from '../../types/index.js';
import { collapseToSingleLine } from '../../core/sanitize.js';

interface AskSecretInput {
  name?: string | undefined;
  prompt?: string | undefined;
  key_type?: string | undefined;
  action?: 'collect' | 'list' | undefined;
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The agent writes the text of a credential dialog, so the text is untrusted
 * input on a security surface — treat it like one at the point where it enters.
 *
 * `name` was already constrained (NAME_PATTERN); `prompt` was not, in any way:
 * no character filter, no length bound, no line bound. That matters because the
 * dialog is line-structured — an icon, one line of text, then the consent row.
 * A prompt carrying newlines could write what looks like further lines of the
 * dialog, and `collapseToSingleLine`'s own doc names the shape: a value that
 * "would otherwise render as a section of its own … a standing instruction the
 * user never wrote". Same argument, a different surface.
 *
 * This is the SERVER half of a pair. The client half is the framing sanitiser
 * the dialog now applies when it renders (`chat-framing.ts`), and neither is
 * load-bearing alone — `src/core/sanitize.ts` calls itself "defense-in-depth
 * behind the client-side framing sanitiser" for exactly this reason.
 *
 * Neither half is what makes the dialog honest, though. That is the product
 * frame in the UI, which the agent cannot write. These two only keep the
 * agent's own span inside the box it was given.
 */
const PROMPT_MAX_CHARS = 300;

/**
 * What forges a quote rather than filling it: bidi overrides and isolates
 * (a span that reads forwards on screen and backwards in the store, so the
 * quote is no longer a quote) and the zero-width formatters (a box that looks
 * empty but is not). `collapseToSingleLine` covers neither — it handles C0/C1
 * and the exotic separators. LRM/RLM are left alone; see the note on the
 * client half in `chat-framing.ts`.
 */
const FORGING_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

/** Collapse to one line and bound the length, ellipsising when it had to cut. */
function boundPromptText(s: string): string {
  // Strip BEFORE collapsing — removing a character from between two spaces after
  // the collapse leaves both spaces behind, and a leading override leaves a
  // leading space.
  const flat = collapseToSingleLine(s.replace(FORGING_CHARS, ''));
  // Cut by CODE POINT, not by UTF-16 unit: `'a'.repeat(298) + '😀'` sliced at
  // 299 units ends on a lone high surrogate, which round-trips to U+FFFD.
  const points = [...flat];
  return points.length > PROMPT_MAX_CHARS
    ? `${points.slice(0, PROMPT_MAX_CHARS - 1).join('')}…`
    : flat;
}

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
        action: {
          type: 'string',
          enum: ['collect', 'list'],
          description:
            'Optional, default "collect" (prompt for a new secret). "list" returns already-stored secret ' +
            'names (masked, no plaintext) so you reference an existing key instead of re-collecting it.',
        },
        name: {
          type: 'string',
          description:
            'Vault key name in UPPER_SNAKE_CASE (e.g. STRIPE_API_KEY, GITHUB_TOKEN). ' +
            'Must start with a letter, only A-Z, 0-9, underscore. Max 64 chars. Required for action:"collect".',
        },
        prompt: {
          type: 'string',
          description: 'Human-readable prompt shown to the user (e.g. "Enter your Stripe API key"). Required for action:"collect".',
        },
        key_type: {
          type: 'string',
          description:
            'Optional key type hint for client-side prefix validation. ' +
            'Examples: "stripe" (sk_live_/sk_test_), "openai" (sk-), "github" (ghp_/gho_/ghs_)',
        },
      },
      required: [],
    },
  },
  detailedGuidance:
    'For a third-party API/integration credential, first confirm the consuming integration exists — ' +
    'you created/bootstrapped its api_setup profile this turn, or api_setup({action:"list"|"view"}) shows it registered. ' +
    'Asking before the integration is set up is a dead end (you do not yet know the auth scheme or key format, ' +
    'and the user has nothing to plug it into). This applies only to a credential a specific api_setup integration ' +
    'will consume — not to standalone keys (an LLM provider key, or a token used directly via http_request).',
  handler: async (input: AskSecretInput, agent: IAgent): Promise<string> => {
    const action = input.action ?? 'collect';

    if (action === 'list') {
      // Read-only discovery: surface the names the agent MAY reference (infra
      // secrets excluded) + masked values — never plaintext. The fresh, queryable
      // counterpart to the boot-time <secrets> briefing, which goes stale the
      // moment a secret is stored mid-session.
      const store = agent.secretStore;
      const names = store?.listAgentVisibleNames?.() ?? [];
      if (names.length === 0) {
        return 'No secrets are stored in the vault yet. Use ask_secret (action:"collect") to add one.';
      }
      const listing = names.map(n => `${n} (${store!.getMasked(n) ?? '****'})`).join(', ');
      return `Secrets already in the vault — reference with secret:NAME, never re-collect an existing one:\n${listing}`;
    }

    // action: 'collect'
    if (!input.name || !input.prompt) {
      return 'Error: ask_secret with action:"collect" needs both `name` and `prompt`. To see what is already stored, call ask_secret with action:"list".';
    }
    if (!NAME_PATTERN.test(input.name)) {
      return `Error: Invalid secret name "${input.name}". Must be UPPER_SNAKE_CASE (A-Z, 0-9, _), start with a letter, max 64 chars.`;
    }

    // Reconcile an already-stored name BEFORE prompting. Two match classes with DIFFERENT
    // handling — the distinction is what keeps a legitimate SECOND key in the same vendor
    // namespace reachable:
    //  - EXACT (normalized) match — a re-spelling of a key already stored (Z_AI_API_KEY
    //    vs a stored ZAI_API_KEY). Collecting would duplicate it → HARD-BLOCK, point at
    //    the existing name.
    //  - VENDOR-namespace-only match — same leading token, different key (DATAFORSEO_API_
    //    LOGIN while DATAFORSEO_B64 is stored; AWS_SECRET_ACCESS_KEY after
    //    AWS_ACCESS_KEY_ID; STRIPE_API_KEY after STRIPE_WEBHOOK_SECRET). A vendor
    //    legitimately holds more than one distinct key, so blocking here would dead-end a
    //    genuine second key (and tempt referencing the WRONG existing one). Surface the
    //    sibling as a non-blocking hint on the prompt and STILL collect.
    const nearMatches = agent.secretStore?.findNameMatches?.(input.name) ?? [];
    const normName = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const reqNorm = normName(input.name);
    const exactMatches = nearMatches.filter(n => normName(n) === reqNorm);
    if (exactMatches.length > 0) {
      const refs = exactMatches.map(n => `secret:${n}`).join(' or ');
      return `A key with the same name is already in the vault: ` +
        `${exactMatches.map(n => `"${n}"`).join(', ')}. Reference ${refs} instead of collecting a duplicate. ` +
        `Only collect again if you genuinely need a separate key under a clearly different name.`;
    }
    // Bounded, and the bound is not cosmetic: this hint is appended AFTER the
    // agent's (capped) text, so it is the tail of the string the dialog renders.
    // Left unbounded it grows ~64 chars per sibling key, and a vault with a
    // dozen keys under one vendor pushes the whole hint past the render cap —
    // truncating the one line in that box the agent does NOT author. Three names
    // is what a person reads; the rest are a count.
    const HINT_NAMES_SHOWN = 3;
    const shown = nearMatches.slice(0, HINT_NAMES_SHOWN);
    const overflow = nearMatches.length - shown.length;
    const nameList = shown.map(n => `"${n}"`).join(', ')
      + (overflow > 0 ? ` and ${String(overflow)} more` : '');
    const vendorHint = nearMatches.length > 0
      ? ` (Related keys already in the vault under the same vendor: ${nameList} — ` +
        `reference one of those with secret:NAME if this is the same credential; otherwise continue to store the new key.)`
      : '';

    if (!agent.promptSecret) {
      return 'Secure secret input is not available in this context. Ask the user to enter the key in Settings → API Keys instead. Do NOT ask the user to paste the secret into chat.';
    }

    // `vendorHint` is engine-composed and follows the agent's own text. Both
    // land in the dialog's quoted-from-the-assistant box, so the hint is shown
    // as slightly less trusted than it is — the safe direction, and stated here
    // rather than left for a reader to notice. Separating the two on the wire
    // needs `segments_json` (the column exists; `insertAskSecret` never fills
    // it) and is a bigger cut than the frame this change is about.
    const outcome = await agent.promptSecret(
      input.name,
      `${boundPromptText(input.prompt)}${vendorHint}`,
      input.key_type,
    );

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
        return `The vault rejected "${input.name}" because this name maps to engine or channel infrastructure (mail-account / OAuth / engine-internal credentials), which is managed by the platform, so the agent cannot collect it. Reply to the user in their language (NOT this template language) — paraphrase the shape below:
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
