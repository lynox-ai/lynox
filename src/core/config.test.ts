import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock node:os and node:process to control homedir and cwd
const tmpBase = mkdtempSync(join(tmpdir(), 'lynox-config-'));
const fakeHome = join(tmpBase, 'home');
const fakeProject = join(tmpBase, 'project');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeProject, { recursive: true });

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

const originalCwd = process.cwd;

describe('Config', () => {
  beforeEach(() => {
    process.cwd = () => fakeProject;
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['LYNOX_WORKSPACE'];
    delete process.env['VOYAGE_API_KEY'];
    delete process.env['LYNOX_EMBEDDING_PROVIDER'];
    delete process.env['LYNOX_USER'];
    delete process.env['LYNOX_ORG'];
    delete process.env['LYNOX_CLIENT'];
    delete process.env['GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_SECRET'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BRAVE_API_KEY'];
    // Clean up any config files from previous tests
    rmSync(join(fakeHome, '.lynox'), { recursive: true, force: true });
    rmSync(join(fakeProject, '.lynox'), { recursive: true, force: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  it('returns empty config when no files exist', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('loads user-level config', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_tier: 'sonnet', effort_level: 'high' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('sonnet');
    expect(config.effort_level).toBe('high');
  });

  it('project config overrides user config', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ default_tier: 'opus', effort_level: 'high' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ default_tier: 'sonnet' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('sonnet');
    expect(config.effort_level).toBe('high');
  });

  it('env vars override config files', async () => {
    const userDir = join(fakeHome, '.lynox');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_key: 'sk-from-file' }));

    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_key).toBe('sk-from-env');
  });

  it('saveUserConfig writes with 0600 permissions', async () => {
    const { saveUserConfig } = await import('./config.js');
    saveUserConfig({ api_key: 'sk-test-123', default_tier: 'haiku' });

    const filePath = join(fakeHome, '.lynox', 'config.json');
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.api_key).toBe('sk-test-123');
    expect(content.default_tier).toBe('haiku');

    const stats = statSync(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('hasApiKey detects env var', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(true);
  });

  it('hasApiKey detects config file', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ api_key: 'sk-test' }));

    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(true);
  });

  it('hasApiKey returns false when no key', async () => {
    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(false);
  });

  it('handles malformed JSON gracefully', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json');

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('ANTHROPIC_BASE_URL env overrides config', async () => {
    process.env['ANTHROPIC_BASE_URL'] = 'http://localhost:3042';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('http://localhost:3042');
  });

  it('project config cannot override api_key', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_key: 'sk-user-safe' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ api_key: 'sk-malicious-override' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_key).toBe('sk-user-safe');
  });

  it('project config cannot override api_base_url', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_base_url: 'https://safe.api.com' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ api_base_url: 'https://evil.api.com' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('https://safe.api.com');
  });

  it('project config can override safe fields', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ default_tier: 'opus', effort_level: 'high' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ default_tier: 'sonnet', effort_level: 'max' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('sonnet');
    expect(config.effort_level).toBe('max');
  });

  it('saveUserConfig creates dir with 0700 permissions', async () => {
    const { saveUserConfig } = await import('./config.js');
    saveUserConfig({ default_tier: 'haiku' });

    const dirStats = statSync(join(fakeHome, '.lynox'));
    expect(dirStats.mode & 0o777).toBe(0o700);
  });

  it('LYNOX_ORG env sets organization_id', async () => {
    process.env['LYNOX_ORG'] = 'acme';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.organization_id).toBe('acme');
  });

  it('LYNOX_CLIENT env sets client_id', async () => {
    process.env['LYNOX_CLIENT'] = 'client1';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.client_id).toBe('client1');
  });

  it('project config can override organization_id (safe key)', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ organization_id: 'user-org' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ organization_id: 'project-org' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.organization_id).toBe('project-org');
  });

  it('project config can override client_id (safe key)', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ client_id: 'user-client' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ client_id: 'project-client' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.client_id).toBe('project-client');
  });
});
