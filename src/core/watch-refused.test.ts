import { describe, it, expect } from 'vitest';
import { watchPolicyRefusal, watchRefusedNow } from './task-manager.js';

// What the Triggers view is told about a watch the network policy keeps from its page (U-392): the
// policy's own reason, computed from the policy as it is now, the same check the poll runs.

const ctx = (networkPolicy: 'allow-list' | 'deny-all' | 'guarded' | 'allow-all', enforceHttps = false) => ({
  networkPolicy, allowedHosts: new Set(['listed.example']), allowedWildcards: [] as string[], enforceHttps,
});
const watch = (url: unknown) => ({ source: 'watch' as const, watch_config: JSON.stringify({ url, interval_minutes: 60 }) });

describe('watchRefusedNow', () => {
  it('names the host under allow-list, deny-all without one, and https under enforce_https', () => {
    expect(watchRefusedNow(watch('https://other.example/p'), ctx('allow-list'))).toEqual({ kind: 'watch_allow_list', host: 'other.example' });
    expect(watchRefusedNow(watch('https://listed.example/p'), ctx('deny-all'))).toEqual({ kind: 'watch_deny_all' });
    expect(watchRefusedNow(watch('http://other.example/p'), ctx('guarded', true))).toEqual({ kind: 'watch_https' });
  });

  it('tells the reason by the whole refusal, not by a word a host name carries', () => {
    expect(watchRefusedNow(watch('https://network_policy=deny-all.x/p'), ctx('allow-list'))).toEqual({ kind: 'watch_allow_list', host: 'network_policy=deny-all.x' });
  });

  it('under enforce_https tells the reason the https address would meet too', () => {
    expect(watchRefusedNow(watch('http://listed.example/p'), ctx('deny-all', true))).toEqual({ kind: 'watch_deny_all' });
    expect(watchRefusedNow(watch('http://other.example/p'), ctx('allow-list', true))).toEqual({ kind: 'watch_allow_list', host: 'other.example' });
    expect(watchRefusedNow(watch('http://listed.example/p'), ctx('allow-list', true))).toEqual({ kind: 'watch_https' });
    expect(watchRefusedNow(watch('HTTP://user:pw@other.example/p'), ctx('allow-list', true))).toEqual({ kind: 'watch_allow_list', host: 'other.example' });
  });

  it('tells the model both steps when the https address would be refused too', () => {
    expect(watchPolicyRefusal('http://other.example/p', ctx('allow-list', true))).toEqual({
      why: "its host other.example is not in this instance's network allow-list.",
      wayOut: 'The operator can add the host to the allow-list (network_policy). The address must also be https://, since this instance only reads HTTPS pages (enforce_https).',
      shown: { kind: 'watch_allow_list', host: 'other.example' },
    });
    expect(watchPolicyRefusal('http://listed.example/p', ctx('deny-all', true))).toEqual({
      why: "this instance's network_policy is deny-all, so lynox reads no web page.",
      wayOut: 'Only the operator can change network_policy. The address must also be https://, since this instance only reads HTTPS pages (enforce_https).',
      shown: { kind: 'watch_deny_all' },
    });
    expect(watchPolicyRefusal('http://listed.example/p', ctx('allow-list', true))).toEqual({
      why: 'this instance only reads HTTPS pages (enforce_https).', wayOut: 'Watch the https:// address instead.', shown: { kind: 'watch_https' },
    });
  });

  it('tells a refusal of the https address that no setting names as it is, without a way out or a line in the view', () => {
    expect(watchPolicyRefusal('http://10.0.0.1/p', ctx('guarded', true))).toEqual({
      why: 'this instance\'s network settings refuse it: private IP address "10.0.0.1".', wayOut: '', shown: null,
    });
    const unknown = { ...ctx('guarded', true), networkPolicy: 'no-such-policy' } as unknown as Parameters<typeof watchPolicyRefusal>[1];
    expect(watchPolicyRefusal('http://listed.example/p', unknown)).toEqual({
      why: 'this instance\'s network settings refuse it: network access denied (unrecognised egress policy).', wayOut: '', shown: null,
    });
  });

  it('says nothing for a page that is read', () => {
    expect(watchRefusedNow(watch('https://listed.example/p'), ctx('allow-list'))).toBeNull();
    expect(watchRefusedNow(watch('https://other.example/p'), ctx('guarded'))).toBeNull();
    expect(watchRefusedNow(watch('https://other.example/p'), ctx('allow-all'))).toBeNull();
  });

  it('says nothing for a trigger that is no watch, a config it cannot read, or a reason only the poll knows', () => {
    expect(watchRefusedNow({ source: 'cron', watch_config: undefined }, ctx('deny-all'))).toBeNull();
    // Only a watch is read by its config: another trigger that carries one says nothing.
    expect(watchRefusedNow({ source: 'cron', watch_config: JSON.stringify({ url: 'https://other.example/p' }) }, ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow({ source: 'watch', watch_config: '{not json' }, ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow(watch(''), ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow(watch('ftp://other.example/p'), ctx('allow-list'))).toBeNull();
  });
});
