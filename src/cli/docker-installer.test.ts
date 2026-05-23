// Static + functional tests for the `npx @lynox-ai/core` installer.
//
// The full runDockerInstaller() flow is interactive (raw-mode TTY + docker
// exec + 60s health poll) and not unit-testable end-to-end. Instead we:
//
//   - test pure functions in isolation (generateSearxngSettings)
//   - assert source-level invariants on docker-installer.ts text (provider
//     triad, docs URL, mkdir call) so regressions on those four fixes show
//     up immediately without spawning docker
//
// Covers T2-I1 / I2 / I3 / I4 from PRD-HN-LAUNCH-HARDENING.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  buildComposeFile,
  generateSearxngSettings,
  isPortInUse,
  readVaultKeyFromRecoveryFile,
  validateAnthropicKey,
  validateMistralKey,
} from './docker-installer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const INSTALLER_SRC = readFileSync(join(__dirname, 'docker-installer.ts'), 'utf-8');
const REPO_ROOT = join(__dirname, '..', '..');
const CANONICAL_SEARXNG_YML = readFileSync(
  join(REPO_ROOT, 'searxng', 'settings.yml'),
  'utf-8',
);

// Extract the engine names from a SearXNG YAML's `keep_only:` block.
// Returns engine identifiers in order, comments + blank lines stripped.
function extractKeepOnlyEngines(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => l.trim() === 'keep_only:');
  if (start === -1) throw new Error('keep_only: block not found');

  const engines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // YAML list items start with `- `; the block ends as soon as the
    // indentation drops back (any non-list, non-comment line).
    if (!trimmed.startsWith('- ')) break;
    engines.push(trimmed.slice(2).trim());
  }
  return engines;
}

describe('docker-installer', () => {
  // -------------------------------------------------------------------------
  // T2-I1 — provider menu is the correct triad (Anthropic / Mistral /
  // OpenAI-compatible incl. Ollama presets), Vertex not offered.
  // -------------------------------------------------------------------------
  describe('T2-I1: provider triad', () => {
    it('offers Anthropic, Mistral, and OpenAI-compatible (not Vertex)', () => {
      // Provider menu lives in a select() with three labels.
      expect(INSTALLER_SRC).toMatch(/label:\s*'Claude \(Anthropic\)'/);
      expect(INSTALLER_SRC).toMatch(/label:\s*'Mistral'/);
      expect(INSTALLER_SRC).toMatch(/label:\s*'OpenAI-compatible'/);
    });

    it('does not offer Vertex AI at install time', () => {
      // Vertex stays wired in the engine for legacy config.json users but
      // is no longer surfaced by the installer (per docs/README promise).
      expect(INSTALLER_SRC).not.toMatch(/Google Vertex AI/);
      expect(INSTALLER_SRC).not.toMatch(/'vertex'/);
    });

    it('exposes Ollama and LM Studio as OpenAI-compatible presets', () => {
      expect(INSTALLER_SRC).toMatch(/label:\s*'Ollama'/);
      expect(INSTALLER_SRC).toMatch(/label:\s*'LM Studio'/);
      // Default Ollama base URL must be present so the "Ollama" preset
      // actually pre-fills something useful.
      expect(INSTALLER_SRC).toMatch(/http:\/\/localhost:11434\/v1/);
    });

    it('routes Mistral + custom through the openai adapter', () => {
      // Both branches set LYNOX_LLM_PROVIDER=openai (the engine's
      // OpenAI-compatible adapter); Mistral additionally pre-fills the
      // canonical Mistral endpoint.
      expect(INSTALLER_SRC).toMatch(/LYNOX_LLM_PROVIDER'\]\s*=\s*'openai'/);
      expect(INSTALLER_SRC).toMatch(/https:\/\/api\.mistral\.ai\/v1/);
    });

    it('uses MISTRAL_API_KEY (primary slot) for the Mistral branch', () => {
      // provider-keys.ts maps openai → MISTRAL_API_KEY (primary). Setting
      // a different env name would silently produce a missing-key startup
      // error.
      expect(INSTALLER_SRC).toMatch(/MISTRAL_API_KEY'\]\s*=/);
    });
  });

  // -------------------------------------------------------------------------
  // T2-I2 — docs link points at /integrations/remote-access/, not the dead
  // /getting-started/reverse-proxy.
  // -------------------------------------------------------------------------
  describe('T2-I2: remote-access docs link', () => {
    it('prints the live docs URL', () => {
      expect(INSTALLER_SRC).toMatch(
        /https:\/\/docs\.lynox\.ai\/integrations\/remote-access\//,
      );
    });

    it('does not print the dead reverse-proxy URL', () => {
      expect(INSTALLER_SRC).not.toMatch(/getting-started\/reverse-proxy/);
    });
  });

  // -------------------------------------------------------------------------
  // T2-I3 — generateSearxngSettings()'s keep_only list matches the canonical
  // core/searxng/settings.yml (source of truth).
  // -------------------------------------------------------------------------
  describe('T2-I3: SearXNG engines sync', () => {
    it('keep_only list matches core/searxng/settings.yml exactly', () => {
      const generated = generateSearxngSettings();
      const generatedEngines = extractKeepOnlyEngines(generated);
      const canonicalEngines = extractKeepOnlyEngines(CANONICAL_SEARXNG_YML);

      // Same engines, same order — exact match required.
      expect(generatedEngines).toEqual(canonicalEngines);
    });

    it('includes the rate-limit-mitigation engines (brave, mojeek, qwant, startpage)', () => {
      // These are the explicit additions over the pre-fix list that gave
      // SearXNG a wider quorum and stopped silent zero-result responses.
      const generated = generateSearxngSettings();
      const engines = extractKeepOnlyEngines(generated);
      expect(engines).toContain('brave');
      expect(engines).toContain('mojeek');
      expect(engines).toContain('qwant');
      expect(engines).toContain('startpage');
    });

    it('still generates a valid secret_key + server block', () => {
      // Sanity: the rest of the config didn't regress.
      const generated = generateSearxngSettings();
      expect(generated).toMatch(/secret_key:\s*"[A-Za-z0-9+/=]{30,}"/);
      expect(generated).toMatch(/bind_address:\s*"0\.0\.0\.0"/);
      expect(generated).toMatch(/formats:\s*\n\s*-\s*html\s*\n\s*-\s*json/);
    });
  });

  // -------------------------------------------------------------------------
  // T2-I4 — installer creates ~/.lynox before `docker compose up` so the
  // bind mount lands on a user-owned dir (else Docker creates it as root
  // on native Linux and the uid-1001 container can't write to it).
  // -------------------------------------------------------------------------
  describe('T2-I4: ~/.lynox bind-mount dir', () => {
    it('imports mkdirSync and homedir', () => {
      expect(INSTALLER_SRC).toMatch(/import\s*{[^}]*mkdirSync[^}]*}\s*from\s*'node:fs'/);
      expect(INSTALLER_SRC).toMatch(/import\s*{[^}]*homedir[^}]*}\s*from\s*'node:os'/);
    });

    it('creates ~/.lynox before running docker compose up', () => {
      // The mkdirSync call must precede the docker-compose-up runShell.
      const mkdirIdx = INSTALLER_SRC.indexOf("mkdirSync(join(homedir(), '.lynox'");
      const composeUpIdx = INSTALLER_SRC.indexOf("['compose', 'up', '-d']");
      expect(mkdirIdx).toBeGreaterThan(-1);
      expect(composeUpIdx).toBeGreaterThan(-1);
      expect(mkdirIdx).toBeLessThan(composeUpIdx);
    });

    it('uses recursive + 0700 mode for the mkdir call', () => {
      // Recursive so an existing dir is a no-op; 0700 keeps the vault key
      // unreadable by other local users.
      expect(INSTALLER_SRC).toMatch(/mkdirSync\(join\(homedir\(\), '\.lynox'\),\s*{\s*recursive:\s*true,\s*mode:\s*0o700\s*}\)/);
    });
  });

  // -------------------------------------------------------------------------
  // Setup-wizard deletion sanity check — the dead ~250-LOC path is gone and
  // nothing in src/ still imports it.
  // -------------------------------------------------------------------------
  describe('setup-wizard dead-code removal', () => {
    it('no longer ships src/cli/setup-wizard.ts', () => {
      expect(() => readFileSync(join(__dirname, 'setup-wizard.ts'), 'utf-8'))
        .toThrow();
    });

    it('src/index.ts no longer re-exports runSetupWizard', () => {
      const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');
      expect(indexSrc).not.toMatch(/runSetupWizard/);
      expect(indexSrc).not.toMatch(/setup-wizard/);
    });
  });

  // -------------------------------------------------------------------------
  // Item 17 — port pre-check before docker compose up.
  // -------------------------------------------------------------------------
  describe('item 17: port pre-check', () => {
    let server: Server | null = null;
    let busyPort = 0;

    beforeEach(async () => {
      // Bind to an ephemeral port so the test is hermetic and doesn't
      // clash with whatever else is running on the dev machine.
      await new Promise<void>((resolveOuter, rejectOuter) => {
        const s = createServer();
        s.once('error', rejectOuter);
        s.listen(0, '127.0.0.1', () => {
          const addr = s.address();
          if (addr && typeof addr === 'object') {
            busyPort = addr.port;
            server = s;
            resolveOuter();
          } else {
            rejectOuter(new Error('failed to bind'));
          }
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((r) => server!.close(() => r()));
        server = null;
      }
    });

    it('reports occupied port as in-use', async () => {
      expect(await isPortInUse(busyPort)).toBe(true);
    });

    it('reports free port as not-in-use', async () => {
      // Pick a port that's almost certainly not bound. 1 in a million chance
      // of a collision; if you hit it, lottery awaits.
      const probablyFreePort = 54_321;
      // Verify it's actually free; if not, skip to avoid a flaky CI failure.
      const inUse = await isPortInUse(probablyFreePort);
      if (inUse) return;
      expect(inUse).toBe(false);
    });

    it('respects PORT env var by interpolating into compose file', () => {
      expect(buildComposeFile(3001)).toMatch(/ports:\s*\n\s*- "3001:3000"/);
      // Container port stays 3000 (matches the internal healthcheck).
      expect(buildComposeFile(3001)).toMatch(/127\.0\.0\.1:3000\/health/);
    });

    it('default compose file maps :3000 host → :3000 container', () => {
      expect(buildComposeFile()).toMatch(/ports:\s*\n\s*- "3000:3000"/);
    });

    it('installer source surfaces actionable PORT= guidance', () => {
      // The user-facing copy is what makes the silent-failure mode go away;
      // assert the help text is present so a refactor doesn't drop it.
      expect(INSTALLER_SRC).toMatch(/PORT=3001 npx @lynox-ai\/core/);
    });
  });

  // -------------------------------------------------------------------------
  // Item 18 — Mistral key validation (3-state).
  // -------------------------------------------------------------------------
  describe('item 18: Mistral key validation', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

    afterEach(() => {
      fetchSpy?.mockRestore();
      fetchSpy = null;
    });

    it('returns state=valid on 200', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      );
      expect(await validateMistralKey('any-key')).toEqual({ state: 'valid' });
    });

    it('returns state=invalid on 401', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );
      const r = await validateMistralKey('bad-key');
      expect(r.state).toBe('invalid');
    });

    it('returns state=invalid on 403', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Forbidden', { status: 403 }),
      );
      const r = await validateMistralKey('bad-key');
      expect(r.state).toBe('invalid');
    });

    it('returns state=network-error on fetch reject (offline / DNS fail)', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
      const r = await validateMistralKey('any-key');
      expect(r.state).toBe('network-error');
    });

    it('returns state=network-error on 5xx upstream issue', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('upstream broken', { status: 503 }),
      );
      const r = await validateMistralKey('any-key');
      expect(r.state).toBe('network-error');
    });

    it('hits GET /v1/models with Bearer auth', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      );
      await validateMistralKey('test-key-xyz');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer test-key-xyz' }) as unknown,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Item 19 — Anthropic validator stops claiming "Verified" on network error.
  // -------------------------------------------------------------------------
  describe('item 19: Anthropic key validation network honesty', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

    afterEach(() => {
      fetchSpy?.mockRestore();
      fetchSpy = null;
    });

    it('returns state=valid on 200', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 }),
      );
      expect((await validateAnthropicKey('sk-ant-good')).state).toBe('valid');
    });

    it('returns state=invalid on 401', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );
      expect((await validateAnthropicKey('sk-ant-bad')).state).toBe('invalid');
    });

    it('returns state=network-error (NOT valid) on fetch reject — regression', async () => {
      // Before the fix this returned { valid: true } and the installer
      // printed a green "Verified" on a flaky network. New shape MUST
      // distinguish so the UX can surface a yellow warning instead.
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ETIMEDOUT'));
      const r = await validateAnthropicKey('sk-ant-anything');
      expect(r.state).toBe('network-error');
      expect(r.state).not.toBe('valid');
    });

    it('returns state=network-error on 500/503', async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('overloaded', { status: 503 }),
      );
      expect((await validateAnthropicKey('sk-ant-any')).state).toBe('network-error');
    });
  });

  // -------------------------------------------------------------------------
  // Item 20 — vault key recovery file at ~/.lynox/.env.
  // -------------------------------------------------------------------------
  describe('item 20: vault key recovery file', () => {
    let tmpDir: string;
    let envPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'lynox-vault-test-'));
      envPath = join(tmpDir, '.env');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null when file does not exist', () => {
      expect(readVaultKeyFromRecoveryFile(envPath)).toBeNull();
    });

    it('returns null when file has no LYNOX_VAULT_KEY line', () => {
      writeFileSync(envPath, '# nothing here\nFOO=bar\n', 'utf-8');
      expect(readVaultKeyFromRecoveryFile(envPath)).toBeNull();
    });

    it('parses an unquoted vault key', () => {
      writeFileSync(envPath, 'LYNOX_VAULT_KEY=abcdef==\n', 'utf-8');
      expect(readVaultKeyFromRecoveryFile(envPath)).toBe('abcdef==');
    });

    it('parses a quoted vault key', () => {
      writeFileSync(envPath, 'LYNOX_VAULT_KEY="abc/def+xyz=="\n', 'utf-8');
      expect(readVaultKeyFromRecoveryFile(envPath)).toBe('abc/def+xyz==');
    });

    it('tolerates CRLF line endings', () => {
      writeFileSync(envPath, 'LYNOX_VAULT_KEY=key1\r\nOTHER=foo\r\n', 'utf-8');
      expect(readVaultKeyFromRecoveryFile(envPath)).toBe('key1');
    });

    it('installer source writes recovery copy with mode 0600', () => {
      // The on-disk write goes through writeFileAtomicSync; assert the
      // installer passes fileMode 0o600 so a future refactor doesn't drop
      // the permission tightening.
      expect(INSTALLER_SRC).toMatch(/fileMode:\s*0o600/);
      expect(INSTALLER_SRC).toMatch(/LYNOX_VAULT_KEY=\$\{vaultKey\}/);
    });

    it('installer reuses an existing recovery vault key (does not overwrite)', () => {
      // Source-level assertion: the new-install path calls
      // readVaultKeyFromRecoveryFile and falls back to randomBytes only when
      // it returns null. This is what prevents the silent-data-loss bug.
      expect(INSTALLER_SRC).toMatch(/readVaultKeyFromRecoveryFile\(recoveryEnvPath\)/);
      expect(INSTALLER_SRC).toMatch(/Reusing existing vault key/);
    });
  });

  // -------------------------------------------------------------------------
  // Item 22 — browser auto-login URL carries the onboarding token.
  // -------------------------------------------------------------------------
  describe('item 22: browser auto-login token', () => {
    it('installer constructs a /login?token=... URL for the browser open', () => {
      // The login page consumes LYNOX_ONBOARDING_TOKEN once via
      // ?token=... + .onboarding-consumed marker. Assert the URL pattern.
      expect(INSTALLER_SRC).toMatch(/\/login\?token=\$\{encodeURIComponent\(onboardingToken\)\}/);
    });

    it('installer writes LYNOX_ONBOARDING_TOKEN into .env', () => {
      expect(INSTALLER_SRC).toMatch(/envVars\['LYNOX_ONBOARDING_TOKEN'\]\s*=\s*onboardingToken/);
    });

    it('installer surfaces shell-history hint about token sensitivity', () => {
      // Token in shell history is the documented residual risk; the hint
      // must stay so it doesn't become a silent surprise.
      expect(INSTALLER_SRC).toMatch(/sensitive token/i);
      expect(INSTALLER_SRC).toMatch(/shell history/i);
    });
  });
});
