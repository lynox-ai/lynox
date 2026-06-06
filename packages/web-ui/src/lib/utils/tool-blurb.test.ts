import { describe, it, expect } from 'vitest';
import { toolBlurb } from './tool-blurb.js';

describe('toolBlurb', () => {
  it('drops the LLM-facing tail after the first sentence', () => {
    // The exact jargon tails rafael flagged in the Settings → Tools screenshots.
    expect(toolBlurb('Execute a shell command for system operations, package management, git, or process control. NEVER use for file reads/writes (use read_file/write_file).'))
      .toBe('Execute a shell command for system operations, package management, git, or process control.');
    expect(toolBlurb('Delegate tasks to specialist roles working in parallel. If no role fits, omit role — unrecognised roles error out.'))
      .toBe('Delegate tasks to specialist roles working in parallel.');
  });

  it('strips the api-setup-v2 flag jargon from the api_setup blurb', () => {
    const blurb = toolBlurb('Create, update, delete, list, view, bootstrap, refine, or fetch_token API profiles. Bootstrap is gated behind `api-setup-v2` flag; runs a single Haiku extraction.');
    expect(blurb).toBe('Create, update, delete, list, view, bootstrap, refine, or fetch_token API profiles.');
    expect(blurb).not.toContain('api-setup-v2');
    expect(blurb).not.toContain('Haiku');
  });

  it('collapses whitespace/newlines from multi-line descriptions', () => {
    expect(toolBlurb('Make a targeted edit to an existing file.\n\n- old_string must match exactly.'))
      .toBe('Make a targeted edit to an existing file.');
  });

  it('falls back to a length cap when the first sentence is just an abbreviation', () => {
    const blurb = toolBlurb('e.g. a helper that does a long list of things across many systems and integrations without a clean early sentence break at all here');
    // Not the 4-char "e.g." fragment.
    expect(blurb.length).toBeGreaterThan(25);
  });

  it('returns short single-sentence descriptions unchanged', () => {
    expect(toolBlurb('Ask the user one or more questions and wait for their response.'))
      .toBe('Ask the user one or more questions and wait for their response.');
  });
});
