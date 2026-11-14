import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A refusal of the cap check that names neither cap. Its one real cause: the caps are set but
// cannot be checked, because the run history did not open at boot (no cost provider). The
// budget module, the gate and the runner are the real ones.
import { checkPersistentBudget, configurePersistentBudget, resetPersistentBudget } from '../../core/session-budget.js';
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
  configurePersistentBudget({ costProvider: null, dailyCapUSD: 5, monthlyCapUSD: 500 });
});
afterEach(() => { mail.close(); resetPersistentBudget(); });

describe('buildInboxRunner — the caps cannot be checked (no run history)', () => {
  it('makes no classify call and says the spend is unknown, not that a budget was reached', async () => {
    // The precondition, so the test cannot pass on an allowed check.
    expect(checkPersistentBudget().allowed).toBe(false);
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
    expect(inbox.listItems()[0]?.reasonDe).toBe('KI-Ausgaben gerade unbekannt — manuell prüfen.');
  });
});
