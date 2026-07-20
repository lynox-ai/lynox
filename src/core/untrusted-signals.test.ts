import { describe, it, expect } from 'vitest';
import { deriveTurnUntrusted } from './untrusted-signals.js';

describe('deriveTurnUntrusted (the canonical write-trust / taint union)', () => {
  it('is false when no signal is set (clean business turn)', () => {
    expect(deriveTurnUntrusted({})).toBe(false);
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: false, conversationSawUntrusted: false })).toBe(false);
  });

  it('is true on the bare wrap marker', () => {
    expect(deriveTurnUntrusted({ sawUntrustedData: true })).toBe(true);
  });

  it('is true when an external-content tool ran this turn (the allowlist-by-omission hole the union closes)', () => {
    // The wrap marker is FALSE — web_research/mail/read_file/bash set no marker. The union must
    // still taint, or external-derived content rides out as trusted.
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: true })).toBe(true);
  });

  it('is true on the conversation-sticky signal alone (F5 deferred-injection defence)', () => {
    expect(deriveTurnUntrusted({ sawUntrustedData: false, sawExternalContentTool: false, conversationSawUntrusted: true })).toBe(true);
  });

  it('treats undefined signals as not-set (over-taints only in the safe direction)', () => {
    expect(deriveTurnUntrusted({ sawExternalContentTool: undefined })).toBe(false);
  });
});
