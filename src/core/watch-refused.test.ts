import { describe, it, expect } from 'vitest';
import { watchRefusedNow } from './task-manager.js';

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

  it('says nothing for a page that is read', () => {
    expect(watchRefusedNow(watch('https://listed.example/p'), ctx('allow-list'))).toBeNull();
    expect(watchRefusedNow(watch('https://other.example/p'), ctx('guarded'))).toBeNull();
    expect(watchRefusedNow(watch('https://other.example/p'), ctx('allow-all'))).toBeNull();
  });

  it('says nothing for a trigger that is no watch, a config it cannot read, or a reason only the poll knows', () => {
    expect(watchRefusedNow({ source: 'cron', watch_config: undefined }, ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow({ source: 'watch', watch_config: '{not json' }, ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow(watch(''), ctx('deny-all'))).toBeNull();
    expect(watchRefusedNow(watch('ftp://other.example/p'), ctx('allow-list'))).toBeNull();
  });
});
