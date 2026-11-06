import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentBudgetCheck } from '../../types/index.js';

// A refusal of the cap check that names neither cap: both spends under their limits.
// The check as it stands refuses only with one cap reached, so it is stood in for here;
// the gate and the runner are the real ones.
vi.mock('../../core/session-budget.js', async (importActual) => ({
  ...(await importActual<typeof import('../../core/session-budget.js')>()),
  checkPersistentBudget: (): PersistentBudgetCheck => ({
    allowed: false, todayCostUSD: 1, monthCostUSD: 1, dailyLimitUSD: 5, monthlyLimitUSD: 500,
    reason: 'Spending cap cannot be checked.',
  }),
}));

import { MailStateDb } from '../mail/state.js';
import type { MailAccountConfig } from '../mail/provider.js';
import type { LLMCaller } from './classifier/index.js';
import { buildInboxRunner } from './runner.js';
import { InboxStateDb } from './state.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1', displayName: 'Me', address: 'me@acme.example', preset: 'custom',
  imap: { host: 'i', port: 993, secure: true }, smtp: { host: 's', port: 465, secure: true },
  authType: 'imap', type: 'personal', isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;
beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
});
afterEach(() => { mail.close(); });

describe('buildInboxRunner — a cap refusal that names neither cap', () => {
  it('makes no classify call and names the AI budget without a period', async () => {
    const llm: LLMCaller = vi.fn(async () => 'should-not-be-called');
    const queue = buildInboxRunner({ state: inbox, llm });
    queue.enqueue({
      accountId: 'acct-1',
      threadKey: 'imap:t1',
      classifierInput: {
        accountAddress: 'me@acme.example', accountDisplayName: 'Me', subject: 'Termin?',
        fromAddress: 'mustermann@example.com', fromDisplayName: 'Max', body: 'Hi Me, hast du Zeit?',
      },
    });
    await queue.drain();

    expect(llm).not.toHaveBeenCalled();
    expect(inbox.listItems()[0]?.reasonDe).toBe('KI-Budget erreicht — manuell prüfen.');
  });
});
