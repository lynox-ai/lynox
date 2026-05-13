import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationRouter, type NotificationChannel } from '../../core/notification-router.js';
import { MailStateDb } from '../mail/state.js';
import { startReminderPoller } from './inbox-reminder-poller.js';
import { InboxStateDb } from './state.js';

let mail: MailStateDb;
let state: InboxStateDb;
let router: NotificationRouter;
let captured: Array<{ title: string; body: string }>;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  state = new InboxStateDb(mail.getConnection());
  captured = [];
  router = new NotificationRouter();
  const channel: NotificationChannel = {
    name: 'test',
    send: async (msg) => {
      captured.push({ title: msg.title, body: msg.body });
      return true;
    },
  };
  router.register(channel);
});

function insertReminderItem(subject: string, snoozeUntil: Date, opts: { reasonDe?: string; notify?: boolean } = {}): string {
  const id = state.insertItem({
    accountId: 'a',
    channel: 'email',
    threadKey: `t-${subject || 'empty'}`,
    bucket: 'requires_user',
    confidence: 0.5,
    reasonDe: opts.reasonDe ?? 'r',
    classifiedAt: new Date('2026-05-01'),
    classifierVersion: 'v',
    subject,
  });
  state.setSnooze(id, snoozeUntil, null, true, opts.notify ?? true);
  return id;
}

describe('inbox-reminder-poller', () => {
  it('fires a notification for each wakeable reminder + stamps notified_at', async () => {
    const past = new Date(Date.now() - 5000);
    const id = insertReminderItem('Vertrag prüfen', past);
    const poller = startReminderPoller({ state, router });
    const fired = await poller.tickNow();
    poller.stop();
    expect(fired).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toBe('Vertrag prüfen');
    const item = state.getItem(id);
    expect(item?.notifiedAt).toBeInstanceOf(Date);
  });

  it('does not re-fire on the next tick when notified_at >= snooze_until', async () => {
    const past = new Date(Date.now() - 5000);
    insertReminderItem('x', past);
    const poller = startReminderPoller({ state, router });
    await poller.tickNow();
    expect(captured).toHaveLength(1);
    captured = [];
    await poller.tickNow();
    poller.stop();
    expect(captured).toHaveLength(0);
  });

  it('re-fires after a fresh snooze even if the item was previously notified', async () => {
    // First fire: snooze in the past, poller "now" anchored at t0.
    let t = 100_000;
    const past1 = new Date(t - 5000);
    const id = insertReminderItem('x', past1);
    const poller = startReminderPoller({ state, router, now: () => t });
    await poller.tickNow();
    expect(captured).toHaveLength(1);
    // notified_at stamped at t = 100_000. Now re-snooze to a future-relative
    // time, then advance "now" past it. New snooze_until > notified_at, so
    // the wake fires again.
    captured = [];
    state.setSnooze(id, new Date(t + 10_000), null, true, true);
    t += 20_000;
    await poller.tickNow();
    poller.stop();
    expect(captured).toHaveLength(1);
  });

  it('skips items where notify_on_unsnooze is 0 (plain snooze)', async () => {
    const past = new Date(Date.now() - 5000);
    insertReminderItem('silent snooze', past, { notify: false });
    const poller = startReminderPoller({ state, router });
    await poller.tickNow();
    poller.stop();
    expect(captured).toHaveLength(0);
  });

  it('falls back to reasonDe when subject is empty', async () => {
    const past = new Date(Date.now() - 5000);
    insertReminderItem('', past, { reasonDe: 'Klassifizier-Grund' });
    const poller = startReminderPoller({ state, router });
    await poller.tickNow();
    poller.stop();
    expect(captured[0]?.body).toBe('Klassifizier-Grund');
  });

  it('respects perTickLimit and leaves overflow for the next tick', async () => {
    const past = new Date(Date.now() - 5000);
    for (let i = 0; i < 5; i++) insertReminderItem(`s${i}`, past);
    const poller = startReminderPoller({ state, router, perTickLimit: 2 });
    expect(await poller.tickNow()).toBe(2);
    expect(await poller.tickNow()).toBe(2);
    expect(await poller.tickNow()).toBe(1);
    poller.stop();
  });
});
