// === Inbox smoke test against GreenMail ===
//
// Spins up the inbox runtime against a local GreenMail container and walks
// the full chain: SMTP send -> IMAP fetch -> watcher hook -> rule /
// sensitive-skip / classifier path -> state writes -> audit log.
//
// Requirements:
//   docker run -d --rm --name lynox-smoke-greenmail \
//     -p 13025:3025 -p 13143:3143 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap \
//       -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=smoke:smoke@example.com \
//       -Dgreenmail.verbose=true' \
//     greenmail/standalone:2.0.1
//
// Run:
//   pnpm tsx scripts/inbox-smoke-greenmail.ts
//
// If ANTHROPIC_API_KEY is set, the classifier path runs against real Haiku.
// Otherwise the classifier is stubbed — wiring is verified but the LLM call
// is not.

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { bootstrapInbox } from '../src/integrations/inbox/bootstrap.js';
import { MailStateDb } from '../src/integrations/mail/state.js';
import type { MailAccountConfig, MailEnvelope } from '../src/integrations/mail/provider.js';
import type Anthropic from '@anthropic-ai/sdk';

const IMAP_HOST = '127.0.0.1';
const IMAP_PORT = 13143;
const SMTP_HOST = '127.0.0.1';
const SMTP_PORT = 13025;
const MAILBOX = 'smoke@example.com';
const USER = 'smoke';
const PASS = 'smoke';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-smoke',
  displayName: 'Smoke',
  address: MAILBOX,
  preset: 'custom',
  imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false },
  smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false },
  authType: 'imap',
  type: 'business',
  isDefault: true,
};

interface TestMail {
  label: string;
  from: string;
  subject: string;
  body: string;
  expectPath: 'rule' | 'sensitive-skip' | 'classifier';
  expectBucket?: string;
}

const TEST_MAILS: ReadonlyArray<TestMail> = [
  {
    label: 'normal-business',
    from: 'partner@acme.example',
    subject: 'Termin nächste Woche?',
    body: 'Hi, hast du Zeit am Mittwoch für ein kurzes Sync-Meeting?',
    expectPath: 'classifier',
  },
  {
    label: 'otp',
    from: 'security@bank.example',
    subject: 'Ihr Sicherheitscode',
    body: 'Bestätigungscode: 482917 — gültig 5 Minuten.',
    expectPath: 'sensitive-skip',
  },
  {
    label: 'stripe-key',
    from: 'support@thirdparty.example',
    subject: 'Hier dein API key',
    // Constructed at runtime so GitHub's secret scanner does not flag the
    // source file. Pattern-detection in `sensitive-content.ts` matches the
    // assembled value just the same.
    body: `Use sk${'_'}live${'_'}AbCdEfGhIjKlMnOpQrStUvWx in production. Do not share.`,
    expectPath: 'sensitive-skip',
  },
  {
    label: 'rule-match',
    from: 'noreply@stripe.example',
    subject: 'Receipt for May',
    body: 'Your monthly subscription has been renewed.',
    expectPath: 'rule',
    expectBucket: 'auto_handled',
  },
];

function stubLLM(): {
  client: Anthropic;
  calls: Array<unknown>;
} {
  const calls: Array<unknown> = [];
  const client = {
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                bucket: 'requires_user',
                confidence: 0.88,
                one_line_why_de: 'Stub-Klassifizierer (kein LLM-Call) — sieht aus wie Kunden-Anfrage',
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

async function sendOne(mail: TestMail): Promise<void> {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: USER, pass: PASS },
    tls: { rejectUnauthorized: false },
  });
  await transport.sendMail({
    from: mail.from,
    to: MAILBOX,
    subject: mail.subject,
    text: mail.body,
  });
  transport.close();
}

async function fetchAll(): Promise<MailEnvelope[]> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: USER, pass: PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const envelopes: MailEnvelope[] = [];
  try {
    for await (const msg of client.fetch('1:*', { envelope: true, source: true, uid: true, internalDate: true })) {
      // imapflow v1 returns address as the full string (e.g. "noreply@stripe.example")
      // — not as mailbox + host separately like rfc822 ENVELOPE does.
      const buildAddr = (a: { name?: string | null; address?: string | null }): { address: string; name: string | undefined } => ({
        address: a.address ?? '',
        name: a.name ?? undefined,
      });
      const from = (msg.envelope?.from ?? []).map(buildAddr);
      const to = (msg.envelope?.to ?? []).map((a) => ({ address: a.address ?? '' }));
      envelopes.push({
        uid: msg.uid,
        messageId: msg.envelope?.messageId,
        folder: 'INBOX',
        threadKey: msg.envelope?.messageId ? `imap:${msg.envelope.messageId}` : `imap:INBOX:${String(msg.uid)}`,
        inReplyTo: undefined,
        from: from as ReadonlyArray<{ address: string; name?: string | undefined }> as unknown as MailEnvelope['from'],
        to: to as unknown as MailEnvelope['to'],
        cc: [],
        replyTo: [],
        subject: msg.envelope?.subject ?? '',
        date: msg.internalDate ?? new Date(),
        flags: [],
        snippet: msg.source ? msg.source.toString('utf8').split('\r\n\r\n')[1]?.slice(0, 300) ?? '' : '',
        hasAttachments: false,
        attachmentCount: 0,
        sizeBytes: msg.source?.length ?? 0,
        isAutoReply: false,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return envelopes;
}

async function main(): Promise<void> {
  console.log('=== lynox inbox smoke ===');
  console.log(`GreenMail SMTP ${SMTP_HOST}:${SMTP_PORT} / IMAP ${IMAP_HOST}:${IMAP_PORT}`);
  const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
  console.log(`LLM mode: ${hasKey ? 'real Haiku (ANTHROPIC_API_KEY set)' : 'STUB (no ANTHROPIC_API_KEY — wiring only)'}`);

  // 1. State + runtime
  const mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  const { client: stubClient } = stubLLM();
  // Real client when key is present, stub otherwise.
  const anthropic = hasKey
    ? ((await import('@anthropic-ai/sdk')).default
      ? new ((await import('@anthropic-ai/sdk')).default)({ apiKey: process.env['ANTHROPIC_API_KEY'] })
      : stubClient)
    : stubClient;
  const runtime = bootstrapInbox({
    mailStateDb: mail,
    anthropicClient: anthropic as Anthropic,
    privacyAck: true, // silence the warning in smoke output
  });
  console.log('✓ inbox runtime up\n');

  // 2. Pre-seed a rule that the rule-match test mail will hit.
  runtime.state.insertRule({
    accountId: ACCOUNT.id,
    matcherKind: 'from',
    matcherValue: 'noreply@stripe.example',
    bucket: 'auto_handled',
    action: 'archive',
    source: 'on_demand',
  });
  runtime.rules.invalidate(ACCOUNT.id);

  // 3. Send all test mails into GreenMail.
  for (const m of TEST_MAILS) {
    await sendOne(m);
    console.log(`→ sent: ${m.label} (from=${m.from})`);
  }
  console.log('');

  // 4. Pull every mail via IMAP and drive the watcher hook directly.
  const envelopes = await fetchAll();
  console.log(`← fetched ${String(envelopes.length)} envelopes from IMAP\n`);
  for (const env of envelopes) {
    await runtime.hook(ACCOUNT.id, env);
  }
  await runtime.shutdown();

  // 5. Verify state.
  const items = runtime.state.listItems();
  console.log(`=== persisted items: ${String(items.length)} ===`);
  let pass = 0;
  let fail = 0;
  for (const item of items) {
    const audit = runtime.state.listAuditForItem(item.id);
    const auditPayload = audit[0] ? JSON.parse(audit[0].payloadJson) as Record<string, unknown> : {};
    console.log(
      `\n  thread=${item.threadKey.slice(0, 50)}`
      + `\n    bucket=${item.bucket}  classifier=${item.classifierVersion}`
      + `\n    reason=${item.reasonDe}`
      + `\n    audit[0].action=${audit[0]?.action ?? '(none)'}  actor=${audit[0]?.actor ?? '(none)'}`
      + `\n    audit[0].payload=${JSON.stringify(auditPayload).slice(0, 160)}`,
    );
  }

  // 6. Path verification by classifierVersion shape.
  const byPath: Record<string, number> = { rule: 0, 'sensitive-skip': 0, classifier: 0, unknown: 0 };
  for (const item of items) {
    if (item.classifierVersion.startsWith('rule:')) byPath['rule']!++;
    else if (item.classifierVersion === 'sensitive-prefilter') byPath['sensitive-skip']!++;
    else if (item.classifierVersion.startsWith('haiku-') || item.classifierVersion.startsWith('mistral-')) byPath['classifier']!++;
    else byPath['unknown']!++;
  }
  console.log('\n=== path distribution ===');
  console.log(`  rule short-circuit: ${String(byPath['rule'])}`);
  console.log(`  sensitive-skip:     ${String(byPath['sensitive-skip'])}`);
  console.log(`  classifier:         ${String(byPath['classifier'])}`);
  console.log(`  unknown:            ${String(byPath['unknown'])}`);

  // Expected: 1 rule, 2 sensitive-skip (otp + stripe-key), 1 classifier.
  const expected = { rule: 1, 'sensitive-skip': 2, classifier: 1 };
  for (const [k, v] of Object.entries(expected)) {
    if (byPath[k] === v) {
      console.log(`✓ ${k}: ${String(v)}`);
      pass++;
    } else {
      console.log(`✗ ${k}: expected ${String(v)}, got ${String(byPath[k] ?? 0)}`);
      fail++;
    }
  }

  // 7. Cost-budget reflects real usage (only when real LLM was used).
  if (hasKey) {
    const snap = runtime.budget.snapshot();
    console.log(`\n=== budget snapshot ===`);
    console.log(`  day=${snap.day}  spent=$${snap.spentUSD.toFixed(6)}  budget=$${String(snap.budgetUSD)}  exceeded=${String(snap.exceeded)}`);
  }

  console.log(`\n=== summary ===`);
  console.log(`  ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
