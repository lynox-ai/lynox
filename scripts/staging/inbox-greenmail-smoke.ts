// === inbox-greenmail-smoke.ts ===
//
// End-to-end smoke against the staging engine (engine.lynox.cloud) +
// the Greenmail container on control-staging.lynox.cloud. Walks the four
// wave-2/3 scenarios the unit-test suite can't cover:
//
//   1. Counter increment + decrement (#332's SQL fix)
//   2. Long subject does not break the API response (#332's wrap fix)
//   3. unsnooze_on_reply actuation (#340's classifier hook fix)
//   4. Bulk-prefilter pass-through for transactional 2-level domains (#340)
//
// Each scenario PURGES Greenmail's mailboxes first via the admin REST API
// so state doesn't leak between runs. Auth is via `mint-staging-cookie.sh`.
//
// Usage:
//   pnpm tsx scripts/staging/inbox-greenmail-smoke.ts
//
// Exit code 0 on full pass; non-zero on the first scenario that fails.

import nodemailer from 'nodemailer';

const ENGINE = process.env['ENGINE_URL'] ?? 'https://engine.lynox.cloud';
const GREENMAIL_HOST = process.env['GREENMAIL_HOST'] ?? 'control-staging.lynox.cloud';
const SMTP_PORT = 3025;
const ADMIN_PORT = 8080;
// How long to wait for the inbox classifier to pick up a freshly delivered
// mail. Generous because the staging engine polls IMAP on a cadence + the
// classifier LLM call adds latency.
const CLASSIFY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

interface InboxCounts {
  counts: { requires_user: number; draft_ready: number; auto_handled: number };
  snoozed: number;
}

let SESSION_COOKIE = '';

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (SESSION_COOKIE) headers.set('Cookie', `lynox_session=${SESSION_COOKIE}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function purgeGreenmail(): Promise<void> {
  // Greenmail admin REST returns 204 No Content on success. We tolerate
  // any 2xx — the schema differs across Greenmail versions.
  const res = await fetch(`http://${GREENMAIL_HOST}:${ADMIN_PORT}/api/user/purge`, { method: 'POST' });
  if (!res.ok) throw new Error(`Greenmail purge failed: HTTP ${res.status}`);
}

async function sendMail(from: string, to: string, subject: string, body: string): Promise<void> {
  // `secure: false` plus no TLS — matches the staging mail account config.
  // Greenmail's auth.disabled lets us skip auth here.
  const transporter = nodemailer.createTransport({
    host: GREENMAIL_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: 'staging', pass: 'staging' },
  });
  await transporter.sendMail({ from, to, subject, text: body });
}

async function waitForClassified(prevCount: number, bucket: keyof InboxCounts['counts']): Promise<InboxCounts> {
  const deadline = Date.now() + CLASSIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counts = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;
    if (counts.counts[bucket] > prevCount) return counts;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timeout waiting for ${bucket} > ${prevCount} after ${CLASSIFY_TIMEOUT_MS}ms`);
}

async function getMostRecentItem(bucket: 'requires_user' | 'draft_ready' | 'auto_handled'): Promise<{ id: string; subject: string }> {
  const data = await fetchJson(`${ENGINE}/api/inbox/items?bucket=${bucket}&limit=1`) as {
    items: ReadonlyArray<{ id: string; subject: string }>;
  };
  if (data.items.length === 0) throw new Error(`No items in ${bucket}`);
  return data.items[0]!;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function scenarioCounter(): Promise<void> {
  log('[1/4] counter increment + decrement (#332)');
  await purgeGreenmail();
  const before = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;

  await sendMail(
    'sender@external.example',
    'business-customer@test.lynox.cloud',
    'Smoke counter test — please reply',
    'Hi, this is the staging smoke counter test.',
  );

  log('  waiting for classify…');
  const afterSend = await waitForClassified(before.counts.requires_user, 'requires_user');
  log(`  counts after classify: requires_user=${afterSend.counts.requires_user}`);
  if (afterSend.counts.requires_user !== before.counts.requires_user + 1) {
    throw new Error(`Expected +1 in requires_user, got ${afterSend.counts.requires_user}`);
  }

  const item = await getMostRecentItem('requires_user');
  log(`  archiving item ${item.id}`);
  await fetchJson(`${ENGINE}/api/inbox/items/${item.id}/action`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archived' }),
  });

  const afterArchive = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;
  if (afterArchive.counts.requires_user !== before.counts.requires_user) {
    throw new Error(`Expected counter back to ${before.counts.requires_user}, got ${afterArchive.counts.requires_user}`);
  }
  log('  ✓ counter dekrement works end-to-end');
}

async function scenarioLongSubject(): Promise<void> {
  log('[2/4] long subject passes through unstripped (#332)');
  await purgeGreenmail();
  const before = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;

  const subject = 'Your Hover domain aureliaburlet.com is coming up for renewal in 3 days — please review the auto-renew settings before May 18th';
  await sendMail(
    'sender@external.example',
    'business-customer@test.lynox.cloud',
    subject,
    'Body irrelevant — testing subject pass-through.',
  );

  await waitForClassified(before.counts.requires_user, 'requires_user');
  const item = await getMostRecentItem('requires_user');
  if (item.subject !== subject) {
    throw new Error(`Subject truncated: server has "${item.subject}" (len ${item.subject.length}), expected ${subject.length}`);
  }
  log(`  ✓ ${item.subject.length}-char subject preserved in API response`);
}

async function scenarioUnsnoozeOnReply(): Promise<void> {
  log('[3/4] unsnooze_on_reply actuates on a reply (#340)');
  await purgeGreenmail();
  const before = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;

  // 1. Initial mail → classifier creates item in requires_user
  const subject = 'Smoke unsnooze test thread';
  await sendMail(
    'sender@external.example',
    'business-customer@test.lynox.cloud',
    subject,
    'Initial message.',
  );
  await waitForClassified(before.counts.requires_user, 'requires_user');
  const item = await getMostRecentItem('requires_user');

  // 2. Snooze that item with unsnooze_on_reply=true (default)
  const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await fetchJson(`${ENGINE}/api/inbox/items/${item.id}/snooze`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ until, condition: null, unsnoozeOnReply: true }),
  });
  log(`  snoozed item ${item.id} until ${until}`);

  // 3. Send a reply in the same thread (RFC: same Subject prefix triggers
  //    thread-key match in the classifier).
  await sendMail(
    'sender@external.example',
    'business-customer@test.lynox.cloud',
    `Re: ${subject}`,
    'Reply that should auto-unsnooze.',
  );

  // 4. Poll the item — snooze_until should clear.
  const deadline = Date.now() + CLASSIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await fetchJson(`${ENGINE}/api/inbox/items/${item.id}/full`) as {
      item: { snoozeUntil?: string };
    };
    if (!data.item.snoozeUntil) {
      log('  ✓ snooze cleared after reply');
      return;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Snooze never cleared within timeout');
}

async function scenarioBulkPrefilter(): Promise<void> {
  log('[4/4] bulk-prefilter passes transactional 2-level domain (#340)');
  await purgeGreenmail();
  const before = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;

  // mail.stripe.com is 3 parts → would have been flagged as noise before
  // K-LE-08's fix. Now should reach the classifier.
  await sendMail(
    'invoice@mail.stripe.com',
    'invoice@mail.stripe-fake.test.lynox.cloud',
    'Your Stripe invoice for May is ready',
    'Invoice body — testing that mail.stripe.com is NOT noise-prefiltered.',
  );

  log('  waiting for any bucket to tick…');
  const deadline = Date.now() + CLASSIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counts = await fetchJson(`${ENGINE}/api/inbox/counts`) as InboxCounts;
    const total = counts.counts.requires_user + counts.counts.draft_ready + counts.counts.auto_handled;
    const beforeTotal = before.counts.requires_user + before.counts.draft_ready + before.counts.auto_handled;
    if (total > beforeTotal) {
      log(`  ✓ mail.stripe.com reached the classifier (total now ${total}, was ${beforeTotal})`);
      return;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('mail.stripe.com mail never reached the inbox — bulk-prefilter regression?');
}

// ── Driver ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Cookie mint — same pattern mint-staging-cookie.sh prints. We expect
  // STAGING_COOKIE env or fall back to mint-staging-cookie.sh's output
  // captured via shell.
  if (!process.env['STAGING_COOKIE']) {
    throw new Error('STAGING_COOKIE not set. Run: STAGING_COOKIE=$(./scripts/mint-staging-cookie.sh) pnpm tsx scripts/staging/inbox-greenmail-smoke.ts');
  }
  SESSION_COOKIE = process.env['STAGING_COOKIE'];

  log(`Engine: ${ENGINE}`);
  log(`Greenmail: ${GREENMAIL_HOST}:${SMTP_PORT}/${ADMIN_PORT}`);
  log('');

  const scenarios: Array<{ name: string; run: () => Promise<void> }> = [
    { name: 'counter', run: scenarioCounter },
    { name: 'long-subject', run: scenarioLongSubject },
    { name: 'unsnooze-on-reply', run: scenarioUnsnoozeOnReply },
    { name: 'bulk-prefilter', run: scenarioBulkPrefilter },
  ];

  const failed: string[] = [];
  for (const s of scenarios) {
    try {
      await s.run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ ${s.name} FAILED: ${msg}`);
      failed.push(s.name);
    }
  }

  log('');
  if (failed.length > 0) {
    log(`FAIL — ${failed.length}/${scenarios.length} scenarios failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  log(`PASS — all ${scenarios.length} scenarios green`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
