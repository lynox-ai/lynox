// === inbox_rule_propose — the agent proposes an inbox rule; the owner confirms it ===
//
// A proposal is a rule that waits: it applies to no mail until the owner
// confirms it (`POST /api/inbox/rules/:id/confirm`, owner-only), and only confirmed rules are read
// by the loader. The tool chooses no bucket: a proposal can only send mail to `requires_user`, so a
// proposal that hostile mail talked the agent into can at most make the owner look at more mail.
// At most `maxPending` proposals wait per account. Withheld from a mandate (`mandate-tool-lock.ts`).
//
// The name and the value are text a model wrote after reading foreign mail; they are cut to one
// line and capped here, and the owner reads them before confirming.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import type { MailHooks } from '../context.js';
import type { MailRegistry } from './registry.js';
import { charCount, DESCRIPTION_MAX, DESCRIPTION_MIN, descriptionProblem, MAX_DESCRIPTION_RULES, namesRuleLabel, ruleLine, ruleValue } from '../../inbox/rule-text.js';

export const INBOX_RULE_NAME_MAX = 80;
export const INBOX_RULE_VALUE_MAX = 200;
/** A subject fragment shorter than this would file almost every mail. */
export const INBOX_RULE_SUBJECT_MIN = 3;

type ProposeKind = 'from' | 'subject_contains' | 'matches_description';
const KINDS: readonly ProposeKind[] = ['from', 'subject_contains', 'matches_description'];

export interface InboxRuleProposeInput {
  account: string;
  matcher_kind: ProposeKind;
  matcher_value: string;
  name: string;
}

/** One line, as the owner and the model read it (`inbox/rule-text.ts`). */
function oneLine(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return ruleLine(raw);
}

const INBOX_OFF = 'inbox_rule_propose: the inbox is not running on this instance, so there is nothing to propose a rule for.';

export function createInboxRuleProposeTool(registry: MailRegistry, hooks?: MailHooks): ToolEntry<InboxRuleProposeInput> {
  return {
    definition: {
      name: 'inbox_rule_propose',
      description:
        'Propose an inbox rule for the owner to confirm: mail from one sender address ("from"), mail whose subject contains a phrase ("subject_contains"), or mail a short description in words fits ("matches_description", e.g. "Mahnungen von Lieferanten"; a model checks it) always goes to "requires_user". ' +
        'The rule does nothing until the owner confirms it in the inbox rule view. Use it when the user asks for such a rule, or when you notice mail the user keeps having to look at. ' +
        'Give the rule a short name — the topic it stands for.',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'The mail account id the rule is for.' },
          matcher_kind: { type: 'string', enum: [...KINDS], description: '"from" = one exact sender address; "subject_contains" = a phrase in the subject; "matches_description" = which mail is meant, in words.' },
          matcher_value: { type: 'string', description: `The sender address, or the subject phrase (at least ${String(INBOX_RULE_SUBJECT_MIN)}, at most ${String(INBOX_RULE_VALUE_MAX)} characters), or the description (one line, ${String(DESCRIPTION_MIN)} to ${String(DESCRIPTION_MAX)} characters).` },
          name: { type: 'string', description: `What the rule is called, e.g. "Retoure". At most ${String(INBOX_RULE_NAME_MAX)} characters.` },
        },
        required: ['account', 'matcher_kind', 'matcher_value', 'name'],
      },
    },
    handler: (input: InboxRuleProposeInput, agent: IAgent): Promise<string> => {
      const proposer = hooks?.inboxRuleProposer;
      if (proposer === undefined) return Promise.resolve(INBOX_OFF);
      const account = oneLine(input.account);
      if (account.length === 0 || registry.get(account) === null) {
        return Promise.resolve('inbox_rule_propose: no mail account with that id. The accounts are listed by mail_triage or the inbox.');
      }
      if (!KINDS.includes(input.matcher_kind)) {
        return Promise.resolve('inbox_rule_propose: matcher_kind must be "from", "subject_contains" or "matches_description".');
      }
      const name = oneLine(input.name);
      if (name.length === 0 || charCount(name) > INBOX_RULE_NAME_MAX) {
        return Promise.resolve(`inbox_rule_propose: name must be 1 to ${String(INBOX_RULE_NAME_MAX)} characters.`);
      }
      // The name sits next to the description in the rule check's prompt.
      if (input.matcher_kind === 'matches_description' && namesRuleLabel(name)) {
        return Promise.resolve('inbox_rule_propose: the name must not name a rule label such as R1.');
      }
      const rawValue = typeof input.matcher_value === 'string' ? input.matcher_value : '';
      let value: string;
      if (input.matcher_kind === 'matches_description') {
        // A description is read by a model in the runner; it must read as the owner reads it.
        const problem = descriptionProblem(rawValue);
        if (problem !== null) return Promise.resolve(`inbox_rule_propose: the description ${problem}.`);
        value = rawValue.trim();
      } else {
        const checked = ruleValue(rawValue);
        if (checked.hidden) {
          return Promise.resolve('inbox_rule_propose: matcher_value holds characters a reader does not see. Give the sender or the phrase as it reads.');
        }
        if (checked.multiline) {
          return Promise.resolve('inbox_rule_propose: matcher_value must be one line, as the sender or the subject reads.');
        }
        value = checked.value;
        if (charCount(value) > INBOX_RULE_VALUE_MAX) {
          return Promise.resolve(`inbox_rule_propose: matcher_value is longer than ${String(INBOX_RULE_VALUE_MAX)} characters.`);
        }
        if (input.matcher_kind === 'from') {
          value = value.toLowerCase();
          // A bare address: brackets, a scheme or a list would never equal a sender and only hold a place.
          if (!/^[^\s@<>()[\]{},;:"`]+@[^\s@<>()[\]{},;:"`]+$/.test(value)) {
            return Promise.resolve('inbox_rule_propose: for "from", matcher_value must be one sender address.');
          }
        } else if (value.length < INBOX_RULE_SUBJECT_MIN) {
          return Promise.resolve(`inbox_rule_propose: a subject phrase needs at least ${String(INBOX_RULE_SUBJECT_MIN)} characters.`);
        }
      }
      const result = proposer.propose({
        accountId: account,
        matcherKind: input.matcher_kind,
        matcherValue: value,
        name,
        runId: agent.currentRunId,
      });
      if (!result.ok && result.reason === 'description_limit') {
        return Promise.resolve(
          `Not proposed: this account already has ${String(result.descriptions)} description rules (at most ${String(MAX_DESCRIPTION_RULES)}). ` +
          'The owner has to delete one in the inbox rule view first.',
        );
      }
      if (!result.ok) {
        return Promise.resolve(
          `Not proposed: ${String(result.pending)} rules for this account already wait for the owner (at most ${String(proposer.maxPending)}). ` +
          'The owner has to confirm or delete some in the inbox rule view first.',
        );
      }
      return Promise.resolve(
        // The name is not echoed: it is text the model wrote after reading foreign mail.
        `Proposed the rule ${result.id}. It does nothing yet: it applies once the owner confirms it in the inbox rule view, ` +
        'and then sends matching mail to "requires_user". Tell the user it is waiting for their confirmation.',
      );
    },
  };
}
