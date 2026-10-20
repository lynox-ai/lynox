import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMessageObject } from 'imapflow';

// A stop of the run reaching the IMAP reads (`readCommand` in imap-smtp.ts).
//
// Every `new ImapFlow` hands out a fresh fake, so a test can tell the connection a stopped read
// let go of from the one the next read opens. The fakes' mailbox lock is a real queue, as
// imapflow's is: a lock nobody releases holds every later read on that connection.

interface Fake {
  usable: boolean;
  mailbox: { path: string } | false;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  /** Fire one of imapflow's events, as the socket would. */
  emit: (event: 'close' | 'error') => void;
}

const made = vi.hoisted(() => ({ clients: [] as unknown[], next: [] as unknown[] }));
const mail = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mail.sendMail, close: () => {}, verify: () => Promise.resolve(true) }) },
}));

vi.mock('imapflow', () => {
  function ImapFlow(): unknown {
    const client = made.next.shift() ?? makeFake();
    made.clients.push(client);
    return client;
  }
  return { ImapFlow };
});

// Imports must come AFTER vi.mock calls.
import { ImapSmtpProvider } from './imap-smtp.js';
import type { MailAccountConfig } from '../provider.js';
import { runInCallSlot, type CallSlot } from '../../../core/call-connection.js';

const ACCOUNT: MailAccountConfig = {
  id: 'stop-account',
  displayName: 'Test User',
  address: 'user@example.com',
  preset: 'custom',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
};

function message(): FetchMessageObject {
  return {
    seq: 1,
    uid: 7,
    envelope: {
      date: new Date('2026-10-20T10:00:00Z'),
      subject: 'Hello',
      messageId: '<m7@example.com>',
      from: [{ address: 'alice@example.com' }],
      to: [{ address: 'user@example.com' }],
    },
    flags: new Set<string>(),
    internalDate: new Date('2026-10-20T10:00:00Z'),
    size: 100,
    bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'text/plain', part: '1', size: 10 }] },
    bodyParts: new Map([['1', Buffer.from('body text')]]),
  };
}

async function* yieldAll<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item;
}

/** An iterator whose first `next` never settles: a FETCH the server never answers. */
function hangingIterator(): AsyncIterableIterator<FetchMessageObject> {
  const it: AsyncIterableIterator<FetchMessageObject> = {
    next: () => new Promise(() => {}),
    [Symbol.asyncIterator]: () => it,
  };
  return it;
}

function makeFake(): Fake {
  const events = new EventEmitter();
  let held = false;
  const queued: Array<() => void> = [];
  const lock = (): Promise<{ path: string; release: () => void }> => new Promise((resolve) => {
    const grant = (): void => {
      held = true;
      resolve({
        path: 'INBOX',
        release: () => {
          held = false;
          queued.shift()?.();
        },
      });
    };
    if (held) queued.push(grant);
    else grant();
  });
  return {
    usable: true,
    mailbox: { path: 'INBOX' },
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn((event: string, fn: () => void) => { events.on(event, fn); }),
    getMailboxLock: vi.fn(lock),
    search: vi.fn().mockResolvedValue([7]),
    fetch: vi.fn(() => yieldAll([message()])),
    fetchOne: vi.fn().mockResolvedValue(message()),
    list: vi.fn().mockResolvedValue([{ path: 'Sent', specialUse: '\\Sent' }]),
    append: vi.fn().mockResolvedValue(true),
    emit: (event) => { events.emit(event, event === 'error' ? new Error('socket') : undefined); },
  };
}

/** A fake whose SEARCH the server never answers. */
function hangingSearch(): Fake {
  const fake = makeFake();
  fake.search.mockReturnValue(new Promise(() => {}));
  return fake;
}

function clients(): Fake[] {
  return made.clients as Fake[];
}

/** A call slot whose run can be stopped, as agent.ts builds one. */
function stoppableCall(): { slot: CallSlot; stop: () => void } {
  const abort = new AbortController();
  const slot: CallSlot = { abort };
  return { slot, stop: () => { slot.stoppedByRun = true; abort.abort(); } };
}

/** `p`, or 'still waiting' after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([p, new Promise<'still waiting'>((r) => { setTimeout(() => r('still waiting'), ms); })]);
}

/** Run `read` in a call, wait until `issued` saw its command, stop the call, return the outcome. */
async function stopDuring(read: () => Promise<unknown>, issued: () => void): Promise<unknown> {
  const call = stoppableCall();
  const pending = runInCallSlot(call.slot, read).then(() => 'resolved', (err: unknown) => err);
  await vi.waitFor(issued);
  call.stop();
  return within(pending, 1_000);
}

function expectStopped(outcome: unknown): void {
  expect(outcome).toBeInstanceOf(DOMException);
  expect((outcome as DOMException).name).toBe('AbortError');
}

beforeEach(() => {
  made.clients.length = 0;
  made.next.length = 0;
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({ messageId: '<x@example.com>', accepted: ['bob@example.com'], rejected: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a stopped IMAP read', () => {
  it('a stopped search ends at once, and the next read runs on a new connection; the old one is not closed', async () => {
    made.next.push(hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    const outcome = await stopDuring(() => provider.search({ text: 'x' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); });
    expectStopped(outcome);

    await expect(provider.list()).resolves.toHaveLength(1);
    expect(clients()).toHaveLength(2);
    expect(clients()[1]?.search).toHaveBeenCalledTimes(1);
    expect(clients()[0]?.close).not.toHaveBeenCalled();
    expect(clients()[0]?.logout).not.toHaveBeenCalled();
  });

  it('control: without a stop, reads stay on one connection, inside a call or not', async () => {
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    await runInCallSlot(stoppableCall().slot, () => provider.search({ text: 'x' }));
    await provider.list();
    expect(clients()).toHaveLength(1);
    expect(clients()[0]?.connect).toHaveBeenCalledTimes(1);
  });

  it('a list stopped at its SEARCH lets go of the connection', async () => {
    made.next.push(hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.list(), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    await provider.list();
    expect(clients()).toHaveLength(2);
  });

  it('a stop that comes after the read finished lets go of nothing', async () => {
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    const call = stoppableCall();
    await runInCallSlot(call.slot, () => provider.search({ text: 'x' }));
    call.stop();
    await provider.list();
    expect(clients()).toHaveLength(1);
  });

  it('nor one that comes after the read failed', async () => {
    const fake = makeFake();
    fake.search.mockRejectedValueOnce(new Error('boom'));
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    const call = stoppableCall();
    await expect(runInCallSlot(call.slot, () => provider.search({ text: 'x' }))).rejects.toThrow('boom');
    call.stop();
    await provider.list();
    expect(clients()).toHaveLength(1);
  });

  it('the abandoned command answering late, or failing late, changes nothing', async () => {
    const answers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const late = (): Fake => {
      const fake = makeFake();
      fake.search.mockImplementation(() => new Promise((resolve, reject) => { answers.push({ resolve, reject }); }));
      return fake;
    };
    made.next.push(late(), late());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(answers).toHaveLength(1); }));
    answers[0]?.resolve([7]);
    clients()[0]?.emit('close');
    expectStopped(await stopDuring(() => provider.search({ text: 'b' }), () => { expect(answers).toHaveLength(2); }));
    answers[1]?.reject(new Error('socket closed'));
    await new Promise((r) => { setTimeout(r, 20); }); // an unhandled rejection would surface here

    await provider.list();
    expect(clients()).toHaveLength(3);
  });

  it('a lock that fails after the stop is dropped quietly', async () => {
    const fake = makeFake();
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    await provider.list(); // connects
    let fail!: (err: Error) => void;
    fake.getMailboxLock.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));

    expectStopped(await stopDuring(() => provider.search({ text: 'x' }), () => { expect(fake.getMailboxLock).toHaveBeenCalledTimes(2); }));
    fail(new Error('mailbox gone'));
    await new Promise((r) => { setTimeout(r, 20); }); // an unhandled rejection would surface here
    await provider.list();
    expect(clients()).toHaveLength(1);
  });

  it('a list stopped while its FETCH streams lets go of the connection', async () => {
    const fake = makeFake();
    fake.fetch.mockImplementation(() => hangingIterator());
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.list(), () => { expect(fake.fetch).toHaveBeenCalled(); }));
    await provider.list();
    expect(clients()).toHaveLength(2);
  });

  it('a search stopped while its FETCH streams lets go of the connection', async () => {
    const fake = makeFake();
    fake.fetch.mockImplementation(() => hangingIterator());
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'x' }), () => { expect(fake.fetch).toHaveBeenCalled(); }));
    await provider.list();
    expect(clients()).toHaveLength(2);
  });

  it('a mail read stopped at its FETCH of the message lets go of the connection', async () => {
    const fake = makeFake();
    fake.fetchOne.mockReturnValue(new Promise(() => {}));
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.fetch({ uid: 7 }), () => { expect(fake.fetchOne).toHaveBeenCalled(); }));
    await provider.list();
    expect(clients()).toHaveLength(2);
  });

  it('a mail read stopped while its body downloads lets go of the connection', async () => {
    const fake = makeFake();
    fake.fetch.mockImplementation(() => hangingIterator());
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.fetch({ uid: 7 }), () => { expect(fake.fetch).toHaveBeenCalled(); }));
    expect(fake.fetchOne).toHaveBeenCalledTimes(1);
    await provider.list();
    expect(clients()).toHaveLength(2);
  });

  it('a call already stopped opens no connection and sends no command', async () => {
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    const call = stoppableCall();
    call.stop();
    const outcome = await runInCallSlot(call.slot, () => provider.search({ text: 'x' })).then(() => 'resolved', (err: unknown) => err);
    expectStopped(outcome);
    expect(clients()).toHaveLength(0);
  });

  it('a stop while the connection is still being made leaves the connect running for the next read', async () => {
    const fake = makeFake();
    let connected!: () => void;
    fake.connect.mockReturnValue(new Promise<void>((r) => { connected = r; }));
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'x' }), () => { expect(fake.connect).toHaveBeenCalled(); }));
    expect(fake.search).not.toHaveBeenCalled();
    connected();
    await provider.list();
    expect(clients()).toHaveLength(1);
  });

  it('a stop while waiting for the mailbox lock lets go of nothing, and the lock it gets later is released', async () => {
    const fake = makeFake();
    made.next.push(fake);
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    await provider.list(); // connects
    const held = await (fake.getMailboxLock('INBOX') as Promise<{ release: () => void }>);

    expectStopped(await stopDuring(() => provider.search({ text: 'x' }), () => { expect(fake.getMailboxLock).toHaveBeenCalledTimes(3); }));
    held.release(); // the stopped read's lock comes now, and must not stay held

    expect(await within(provider.list(), 1_000)).toHaveLength(1);
    expect(clients()).toHaveLength(1);
    expect(fake.search).toHaveBeenCalledTimes(2);
  });
});

describe('at most one connection let go of per account', () => {
  it('a second stop while the first orphan lives keeps its connection', async () => {
    made.next.push(hangingSearch(), hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    expectStopped(await stopDuring(() => provider.search({ text: 'b' }), () => { expect(clients()[1]?.search).toHaveBeenCalled(); }));

    // The next read queues on the second connection, as it would without a stop.
    void provider.list();
    await vi.waitFor(() => { expect(clients()[1]?.getMailboxLock).toHaveBeenCalledTimes(2); });
    expect(clients()).toHaveLength(2);
  });

  it('once the orphan has closed, a further stop may let go of a connection again', async () => {
    made.next.push(hangingSearch(), hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    clients()[0]?.emit('close'); // the orphan's own socket timeout
    expectStopped(await stopDuring(() => provider.search({ text: 'b' }), () => { expect(clients()[1]?.search).toHaveBeenCalled(); }));

    await provider.list();
    expect(clients()).toHaveLength(3);
  });

  it('an orphan counts until its close, however long that takes', async () => {
    made.next.push(hangingSearch(), hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    // No close yet, however long ago the stop was: a server that answered late keeps the orphan
    // open, since its timeout counts idle time. A deadline would let a second orphan in here.
    expectStopped(await stopDuring(() => provider.search({ text: 'b' }), () => { expect(clients()[1]?.search).toHaveBeenCalled(); }));

    void provider.list();
    await vi.waitFor(() => { expect(clients()[1]?.getMailboxLock).toHaveBeenCalledTimes(2); });
    expect(clients()).toHaveLength(2);
  });

  it('a stop on a connection that already failed records no orphan', async () => {
    made.next.push(hangingSearch(), hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    // The socket fails while the search hangs: the provider has already dropped the connection.
    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => {
      expect(clients()[0]?.search).toHaveBeenCalled();
      clients()[0]?.emit('error');
    }));
    // So the next stop may let go of its connection.
    expectStopped(await stopDuring(() => provider.search({ text: 'b' }), () => { expect(clients()[1]?.search).toHaveBeenCalled(); }));
    await provider.list();
    expect(clients()).toHaveLength(3);
  });

  it('the orphan closing or failing later does not touch the new connection', async () => {
    made.next.push(hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    await provider.list(); // the new connection stands
    clients()[0]?.emit('error');
    clients()[0]?.emit('close');

    await provider.list();
    expect(clients()).toHaveLength(2);
    expect(clients()[1]?.connect).toHaveBeenCalledTimes(1);
  });

  it('closing the provider closes the orphan too', async () => {
    made.next.push(hangingSearch());
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));

    expectStopped(await stopDuring(() => provider.search({ text: 'a' }), () => { expect(clients()[0]?.search).toHaveBeenCalled(); }));
    await provider.close();
    expect(clients()[0]?.close).toHaveBeenCalledTimes(1);
  });
});

describe('only reads can let go of a connection', () => {
  it('a send in a stopped call goes out, and so does its Sent copy', async () => {
    const provider = new ImapSmtpProvider(ACCOUNT, () => ({ user: 'u', pass: 'p' }));
    await provider.list(); // the IMAP connection the Sent copy will use
    const call = stoppableCall();
    call.stop();
    await runInCallSlot(call.slot, () => provider.send({ to: [{ address: 'bob@example.com' }], subject: 's', text: 't' }));
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(clients()[0]?.append).toHaveBeenCalledTimes(1);
    expect(clients()).toHaveLength(1);
  });

  it('the stop helpers are called from list, search, fetch and downloadPartAsText only', () => {
    const source = readFileSync(new URL('./imap-smtp.ts', import.meta.url), 'utf-8');
    const allowed = new Set(['list', 'search', 'fetch', 'downloadPartAsText', 'readClient', 'readLock', 'readCommand']);
    const callers: string[] = [];
    let method = '';
    for (const line of source.split('\n')) {
      const header = /^ {2}(?:private |public )?(?:async )?([A-Za-z]+)\s*[<(]/.exec(line);
      if (header?.[1] !== undefined) method = header[1];
      if (/this\.(readCommand|readClient|readLock)\(/.test(line)) callers.push(method);
    }
    expect(callers.length).toBeGreaterThanOrEqual(10);
    expect(callers.filter((m) => !allowed.has(m))).toEqual([]);
    expect(new Set(callers)).toEqual(new Set(['list', 'search', 'fetch', 'downloadPartAsText']));
  });
});
