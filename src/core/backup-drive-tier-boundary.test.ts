import { describe, it, expect, afterEach } from 'vitest';
import { driveBackupAllowed } from './backup-upload-gdrive.js';

/**
 * Drive backup upload is a SELF-HOST feature.
 *
 * On a CP-provisioned instance the control plane already runs restic backups, so a second
 * backup path to a third party adds exposure without adding safety — and since core#1240 the
 * backup carries the merge ledger, so what travels that path is email, phone, vat_id and
 * domain.
 *
 * The case that makes this a test rather than a comment: the boundary is **who hosts**, not
 * the word "managed". BYOK (`hosted`) is the cheapest tier, runs on lynox hosts, and gets the
 * same CP backups — only the LLM key is the customer's. A check written against
 * `managed`/`managed_pro` would read as correct and leave the redundant path open for exactly
 * the tier most likely to have it enabled.
 */
describe('driveBackupAllowed — the boundary is who hosts, not the tier name', () => {
  const KEYS = ['LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'] as const;
  const saved = new Map<string, string | undefined>();
  const set = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
  });

  it('allows the upload when no tier is set — that is self-host', () => {
    for (const k of KEYS) set(k, undefined);
    expect(driveBackupAllowed()).toBe(true);
  });

  it('refuses it on every CP tier, BYOK included', () => {
    // `hosted` is the one that matters: it is BYOK, it is the cheapest, and it is the tier a
    // "managed only" check would have missed. All three are CP-hosted and CP-backed-up.
    for (const tier of ['hosted', 'managed', 'managed_pro']) {
      for (const k of KEYS) set(k, undefined);
      set('LYNOX_BILLING_TIER', tier);
      expect(driveBackupAllowed(), `tier ${tier} must not upload to Drive`).toBe(false);
    }
  });

  it('honours the legacy LYNOX_MANAGED_MODE alias — an old instance is still CP-hosted', () => {
    // The canonical name is read first with the legacy alias as fallback, forever. An
    // instance whose env still carries only the old name is not self-host.
    for (const k of KEYS) set(k, undefined);
    set('LYNOX_MANAGED_MODE', 'managed');
    expect(driveBackupAllowed()).toBe(false);
  });

  it('an empty value is not a tier — it must not silently disable the upload', () => {
    // Fail-open in this direction is right: an empty env var is a deployment slip, and
    // silently dropping a self-hoster's only backup path would be worse than the exposure
    // this guard prevents.
    for (const k of KEYS) set(k, undefined);
    set('LYNOX_BILLING_TIER', '');
    expect(driveBackupAllowed()).toBe(true);
  });
});
