import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMailRateLimit, configureMailRateLimits, mailSendLimitAdmits, MAIL_RATE_UNCOUNTED, resetMailRateLimits,
} from './rate-limit.js';

const counts = (n: number) => ({ getToolCallCountSince: () => n });

afterEach(() => { resetMailRateLimits(); });

describe('mail send limits without a counter', () => {
  it('the refusal says, verbatim, that nothing was sent or kept, and tells the model not to offer a later send', () => {
    expect(MAIL_RATE_UNCOUNTED).toBe("Blocked: the mail send limit cannot be checked, because the history database did not open when lynox started. This mail was not sent, and nothing keeps it for later. No mail goes out until someone restarts lynox and lynox can open the history database again; the log lynox writes at start says why it could not. Do not retry and do not offer to send it later on your own: nothing will remind you after the restart. Tell the user it was not sent; after the restart they can ask again, or they can send it themselves now. Do not ask whether to try again later either; if they want that, they ask after the restart.");
  });

  it('configured with no provider: refuses with the reason, and the approval queue admits nothing', () => {
    configureMailRateLimits({ provider: null });
    expect(checkMailRateLimit('mail_send')).toBe(MAIL_RATE_UNCOUNTED);
    expect(mailSendLimitAdmits('mail_reply', { hour: 0, day: 0 })).toBe(false);
  });

  it('configured with no provider but only one limit set: still refused', () => {
    configureMailRateLimits({ provider: null, hourlyLimit: Infinity, dailyLimit: 200 });
    expect(checkMailRateLimit('mail_send')).toBe(MAIL_RATE_UNCOUNTED);
  });

  it('configured with no provider and no limit set: nothing to count, nothing refused', () => {
    configureMailRateLimits({ provider: null, hourlyLimit: Infinity, dailyLimit: Infinity });
    expect(checkMailRateLimit('mail_send')).toBeNull();
    expect(mailSendLimitAdmits('mail_send', { hour: 0, day: 0 })).toBe(true);
  });

  it('never configured (a bare library use): no enforcement, as before', () => {
    expect(checkMailRateLimit('mail_send')).toBeNull();
    expect(mailSendLimitAdmits('mail_send', { hour: 0, day: 0 })).toBe(true);
  });

  it('configured with a provider: counts as before, under and at the limit', () => {
    configureMailRateLimits({ provider: counts(3), hourlyLimit: 50, dailyLimit: 200 });
    expect(checkMailRateLimit('mail_send')).toBeNull();
    configureMailRateLimits({ provider: counts(50), hourlyLimit: 50, dailyLimit: 200 });
    expect(checkMailRateLimit('mail_send')).toBe('Blocked: hourly mail_send limit (50) reached. Count: 50. Try again later.');
  });
});
