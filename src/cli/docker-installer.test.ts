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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSearxngSettings } from './docker-installer.js';

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
});
