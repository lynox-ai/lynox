/**
 * The process side of `src/integrations/inbox/shutdown-sigterm.test.ts`: an engine whose inbox
 * has a backlog while the provider hangs, shut down by a real signal through the production
 * signal handler.
 *
 *   tsx tests/fixtures/inbox-sigterm-child.ts <mail-state.db> <mails> <answered>
 *
 * The provider answers the first <answered> calls and never answers the rest, ignoring the abort
 * signal, as a hung provider does. Prints `ready` once those are classified and two more are
 * running; the rest wait. The test then sends SIGTERM.
 */
import { MailStateDb } from '../../src/integrations/mail/state.js';
import { bootstrapInbox } from '../../src/integrations/inbox/bootstrap.js';
import { Engine } from '../../src/core/engine.js';
import { installSignalShutdown } from '../../src/server/signal-shutdown.js';
import type { InboxQueuePayload } from '../../src/integrations/inbox/runner.js';

const [dbPath, mailsArg, answeredArg] = process.argv.slice(2) as [string, string, string];
const mails = Number(mailsArg);
const answered = Number(answeredArg);

const mail = new MailStateDb({ path: dbPath });
mail.upsertAccount({
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
});

let calls = 0;
const client = {
  messages: {
    create: async (): Promise<unknown> => {
      calls += 1;
      if (calls > answered) return new Promise(() => { /* the provider hangs */ });
      await new Promise((r) => setTimeout(r, 10));
      return {
        content: [{ type: 'text', text: JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'Newsletter' }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
};

const runtime = bootstrapInbox({
  mailStateDb: mail,
  anthropicClient: client as never,
  privacyAck: true,
  budget: { maxBudgetUSD: Infinity },
});
const engine = new Engine({ model: 'balanced' });
(engine as unknown as { _inboxRuntime: typeof runtime })._inboxRuntime = runtime;

for (let n = 1; n <= mails; n++) {
  const payload: InboxQueuePayload = {
    accountId: 'acct-1',
    threadKey: `imap:t${String(n)}`,
    classifierInput: {
      accountAddress: 'me@acme.example',
      accountDisplayName: 'Me',
      subject: `Termin ${String(n)}?`,
      fromAddress: 'mustermann@example.com',
      fromDisplayName: 'Max',
      body: `Hi Me, hast du am ${String(n)}. Zeit?`,
    },
    envelope: { fromAddress: 'mustermann@example.com', subject: `Termin ${String(n)}?`, messageId: `<m${String(n)}@x>` },
  };
  if (!runtime.queue.enqueue(payload)) throw new Error(`enqueue ${String(n)} refused`);
}

const classified = (): number =>
  (mail.getConnection().prepare('SELECT COUNT(*) AS n FROM inbox_items').get() as { n: number }).n;
while (!(classified() === answered && runtime.queue.activeCount === 2 && calls === answered + 2)) {
  await new Promise((r) => setTimeout(r, 5));
}

installSignalShutdown(engine);
process.stdout.write('ready\n');
// Keep the process alive the way the server does, until the signal handler exits it.
setInterval(() => { /* alive */ }, 60_000);
