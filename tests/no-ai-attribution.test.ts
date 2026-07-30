/**
 * Tests for scripts/no-ai-attribution.sh.
 *
 * This guard strips AI self-attribution trailers from commit messages. Its first
 * version matched any line STARTING with `Claude-Session:` — and it silently ate a
 * line of prose in the very commit that introduced it, a body explaining the rule
 * ("Claude-Session:, no 'Generated with Claude Code'..."). A guard that fires on
 * obviously-safe lines is the failure it exists to prevent.
 *
 * So the contract has two halves, and both are load-bearing:
 *   - a real trailer is removed
 *   - prose that merely MENTIONS a trailer is not
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/no-ai-attribution.sh', import.meta.url));

let dir: string;
let msgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'no-ai-attr-'));
  msgPath = join(dir, 'COMMIT_EDITMSG');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the strip mode over `message` and return the rewritten file. */
function strip(message: string): string {
  writeFileSync(msgPath, message);
  execFileSync('bash', [SCRIPT, 'strip', msgPath], { encoding: 'utf-8' });
  return readFileSync(msgPath, 'utf-8');
}

describe('no-ai-attribution — strips the real trailers', () => {
  it('removes the Co-Authored-By: Claude trailer', () => {
    const out = strip(
      'Fix the thing\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n',
    );

    expect(out).not.toContain('noreply@anthropic.com');
    expect(out).toContain('Fix the thing');
  });

  it('removes the Claude-Session trailer', () => {
    const out = strip('Fix the thing\n\nClaude-Session: https://claude.ai/code/session_01QFhY\n');

    expect(out).not.toContain('claude.ai/code');
  });

  it('removes the "Generated with Claude Code" line', () => {
    const out = strip(
      'Fix the thing\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
    );

    expect(out).not.toContain('Generated with');
  });

  it('leaves a HUMAN Co-Authored-By alone', () => {
    const out = strip(
      'Fix the thing\n\nCo-Authored-By: Jane Doe <jane@example.com>\n' +
        'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n',
    );

    expect(out).toContain('Jane Doe <jane@example.com>');
    expect(out).not.toContain('anthropic.com');
  });
});

describe('no-ai-attribution — does not eat prose about the trailers', () => {
  // The regression that shipped: these lines START with the trailer words but are
  // ordinary sentences. The guard must leave them alone.
  it('keeps a line that begins with "Claude-Session:" but is prose', () => {
    const body = 'Claude-Session:, no "Generated with Claude Code". It was broken in 332 commits.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('keeps a sentence that mentions Co-Authored-By: Claude mid-line', () => {
    const body = 'The rule forbids Co-Authored-By: Claude and the session link.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('keeps a mid-line mention of generating with Claude Code', () => {
    const body = 'Someone wrote: Generated with Claude Code was the old trailer.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('leaves an untouched message byte-identical', () => {
    const message = 'Add a feature\n\nIt does the thing, for the reason.\n';

    expect(strip(message)).toBe(message);
  });
});
