import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { strictDecrypt, ENCRYPTED_PREFIX } from './strict-decrypt.js';
import { CRYPTO_ALGORITHM, CRYPTO_IV_LENGTH, CRYPTO_TAG_LENGTH } from './crypto-constants.js';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';

/**
 * A stored text decrypted so that the caller always knows whether it got the plaintext: a value
 * that cannot be read never comes back as its text. The lenient readers of the stores keep their
 * behaviour (they hand the stored value back), and both now decrypt through the same function.
 */

/** The stores' format: `enc:` + base64(iv | tag | ciphertext), AES-256-GCM. */
function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(CRYPTO_IV_LENGTH);
  const cipher = createCipheriv(CRYPTO_ALGORITHM, key, iv, { authTagLength: CRYPTO_TAG_LENGTH });
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ENCRYPTED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

describe('strictDecrypt', () => {
  const key = randomBytes(32);

  it('returns a value without the prefix as plain, unchanged, the empty string included', () => {
    expect(strictDecrypt('a plain note', key)).toEqual({ ok: true, kind: 'plain', text: 'a plain note' });
    expect(strictDecrypt('a plain note', null)).toEqual({ ok: true, kind: 'plain', text: 'a plain note' });
    expect(strictDecrypt('', key)).toEqual({ ok: true, kind: 'plain', text: '' });
  });

  it('decrypts a value written under the key', () => {
    expect(strictDecrypt(encrypt('the plaintext', key), key)).toEqual({ ok: true, kind: 'decrypted', text: 'the plaintext' });
  });

  it('says no_key, never the value, when the value is encrypted and no key is set', () => {
    expect(strictDecrypt(encrypt('the plaintext', key), null)).toEqual({ ok: false, kind: 'no_key' });
  });

  it('says failed, never the value, under another key', () => {
    expect(strictDecrypt(encrypt('the plaintext', key), randomBytes(32))).toEqual({ ok: false, kind: 'failed' });
  });

  it('says failed for a plaintext that starts with the prefix, for a cut value, and for a changed tag', () => {
    expect(strictDecrypt(`${ENCRYPTED_PREFIX}just a note that starts like this`, key)).toEqual({ ok: false, kind: 'failed' });
    expect(strictDecrypt(`${ENCRYPTED_PREFIX}${Buffer.from('short').toString('base64')}`, key)).toEqual({ ok: false, kind: 'failed' });
    const stored = encrypt('the plaintext', key);
    const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
    buf[CRYPTO_IV_LENGTH] = (buf[CRYPTO_IV_LENGTH] ?? 0) ^ 0xff;
    expect(strictDecrypt(ENCRYPTED_PREFIX + buf.toString('base64'), key)).toEqual({ ok: false, kind: 'failed' });
  });
});

describe('the stores decrypt through it', () => {
  let dir: string;
  const vaultKey = randomBytes(36).toString('base64');
  const otherKey = randomBytes(36).toString('base64');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strict-decrypt-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('engine.db: decStrict reads its own value and refuses one written under another key; dec and tryDec keep their answers', () => {
    const path = join(dir, 'engine.db');
    const writer = new EngineDb(path, vaultKey);
    const stored = writer.enc('a stored fact');
    writer.close();

    const same = new EngineDb(path, vaultKey);
    try {
      expect(same.decStrict(stored)).toEqual({ ok: true, kind: 'decrypted', text: 'a stored fact' });
      expect(same.dec(stored)).toBe('a stored fact');
      expect(same.tryDec(stored)).toBe('a stored fact');
    } finally { same.close(); }

    const other = new EngineDb(path, otherKey);
    try {
      expect(other.decStrict(stored)).toEqual({ ok: false, kind: 'failed' });
      // The lenient readers: dec hands the stored value back, tryDec says null, as before.
      expect(other.dec(stored)).toBe(stored);
      expect(other.tryDec(stored)).toBeNull();
    } finally { other.close(); }

    const keyless = new EngineDb(join(dir, 'keyless.db'));
    try {
      expect(keyless.decStrict(stored)).toEqual({ ok: false, kind: 'no_key' });
      expect(keyless.dec(stored)).toBe(stored);
      expect(keyless.tryDec(stored)).toBeNull();
      expect(keyless.decStrict('plain')).toEqual({ ok: true, kind: 'plain', text: 'plain' });
    } finally { keyless.close(); }
  });

  it('history.db: decStrict reads a run written under the key and refuses it under another; the lenient read keeps its answer', () => {
    const path = join(dir, 'history.db');
    const writer = new RunHistory(path, vaultKey);
    const id = writer.insertRun({ taskText: 'a task to keep', modelTier: 'balanced', modelId: 'm' });
    writer.close();
    const raw = new Database(path, { readonly: true });
    const stored = (raw.prepare('SELECT task_text FROM runs WHERE id = ?').get(id) as { task_text: string }).task_text;
    raw.close();
    expect(stored.startsWith(ENCRYPTED_PREFIX)).toBe(true);

    const same = new RunHistory(path, vaultKey);
    try {
      expect(same.decStrict(stored)).toEqual({ ok: true, kind: 'decrypted', text: 'a task to keep' });
      expect(same.getRun(id)?.task_text).toBe('a task to keep');
    } finally { same.close(); }

    const other = new RunHistory(path, otherKey);
    try {
      expect(other.decStrict(stored)).toEqual({ ok: false, kind: 'failed' });
      // The lenient read hands the stored value back, as before.
      expect(other.getRun(id)?.task_text).toBe(stored);
    } finally { other.close(); }
  });
});
