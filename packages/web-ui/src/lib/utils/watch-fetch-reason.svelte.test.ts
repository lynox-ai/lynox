import { describe, it, expect, afterEach } from 'vitest';
import { WORKER_NOTICES } from '../../../../../src/core/worker-notices.js';
import type { WatchFetchCause as EngineCause } from '../../../../../src/core/watch-fetch-cause.js';
import { setLocale, getLocale, t } from '../i18n.svelte.js';
import { blockedReasonParts, watchFetchReason, type BlockedReasonKey, type WatchFetchCause } from './blocked-reason.js';

/**
 * The card says why a watch's last run failed in the sentence the engine wrote for the owner's
 * notice, without its lead that names the page. Two copies of one sentence, one per side of the
 * wire: this pins them together for every cause the engine can store, in both languages. A node
 * test, so importing the engine here is fine.
 */

const before = getLocale();
afterEach(() => { setLocale(before); });

const CAUSES: readonly WatchFetchCause[] = [
  { kind: 'blocked' }, { kind: 'refused' }, { kind: 'unresolved' }, { kind: 'unreachable' }, { kind: 'tls' }, { kind: 'other' },
  { kind: 'timeout', seconds: 30 }, { kind: 'too-large', megabytes: 10 },
  ...[100, 200, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 410, 418, 429, 500, 502, 503, 599].map((status) => ({ kind: 'http', status }) as const),
];

describe('the card says a failed watch run\'s cause as the engine does', () => {
  for (const lang of ['de', 'en'] as const) {
    it.each(CAUSES)(`${lang}: %j`, (cause) => {
      setLocale(lang);
      const engine = WORKER_NOTICES[lang].watchFetchReason(cause as EngineCause);
      expect(watchFetchReason(cause, (key: BlockedReasonKey) => t(key))).toBe(engine);
      expect(blockedReasonParts({ kind: 'watch_fetch', cause }, (key: BlockedReasonKey) => t(key))).toEqual({ before: engine, host: null, after: '' });
    });
  }

  it('the engine\'s notice is the lead that names the page, then this sentence', () => {
    for (const lang of ['de', 'en'] as const) {
      const cause = { kind: 'http', status: 404 } as const;
      expect(WORKER_NOTICES[lang].watchFetchFailed('https://shop.example/a', cause).endsWith(` ${WORKER_NOTICES[lang].watchFetchReason(cause)}`)).toBe(true);
    }
  });
});
