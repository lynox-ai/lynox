/**
 * mail-tool — seeds and inspects the probe's mail server. Runs inside the engine
 * image (for its `imapflow`) as a one-off container on the probe network, so it
 * talks to the mail server over the same network the engine uses.
 *
 *   node mail-tool.mjs seed     < messages.json   APPENDs each raw message to INBOX
 *   node mail-tool.mjs inspect                    mailboxes + counts, server users
 *
 * Env: MAIL_HOST, MAIL_USER, MAIL_PASS, MAIL_API (the mail server's REST base).
 * Seeding uses the plain IMAP port on purpose: it is the harness writing fixtures,
 * not the engine, and it keeps the engine's own TLS path the only one under test.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire('/app/package.json');
const { ImapFlow } = require('imapflow');

const host = process.env.MAIL_HOST;
const auth = { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS };
const cmd = process.argv[2];

async function client() {
  const c = new ImapFlow({ host, port: 3143, secure: false, auth, logger: false });
  await c.connect();
  return c;
}

if (cmd === 'seed') {
  const messages = JSON.parse(readFileSync(0, 'utf8'));
  const c = await client();
  // A Sent folder must exist, or the engine's post-send APPEND is skipped silently
  // (imap-smtp.ts) and a sent reply would leave no trace in the mailbox.
  await c.mailboxCreate('Sent').catch(() => {});
  for (const m of messages) await c.append('INBOX', m.raw, [], new Date(m.date));
  const status = await c.status('INBOX', { messages: true, unseen: true });
  await c.logout();
  process.stdout.write(JSON.stringify({ seeded: messages.length, inbox: status }) + '\n');
} else if (cmd === 'inspect') {
  const c = await client();
  const boxes = [];
  for (const b of await c.list()) {
    const s = await c.status(b.path, { messages: true });
    boxes.push({ path: b.path, specialUse: b.specialUse ?? null, messages: s.messages });
  }
  await c.logout();
  let users = null;
  try {
    const r = await fetch(`${process.env.MAIL_API}/api/user`);
    users = await r.json();
  } catch (e) {
    users = { error: String(e) };
  }
  process.stdout.write(JSON.stringify({ boxes, users }) + '\n');
} else {
  process.stderr.write('usage: mail-tool.mjs seed|inspect\n');
  process.exit(2);
}
