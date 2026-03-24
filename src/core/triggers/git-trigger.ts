import { writeFileSync, readFileSync, watch, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ITrigger, TriggerCallback, GitTriggerConfig } from '../../types/index.js';

export class GitTrigger implements ITrigger {
  readonly type = 'git';
  private readonly hook: string;
  private readonly repoDir: string;
  private readonly signalFile: string;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(config: GitTriggerConfig) {
    this.hook = config.hook;
    this.repoDir = resolve(config.repoDir ?? '.');
    this.signalFile = join(this.repoDir, '.git', 'nodyn-trigger-signal');
  }

  start(callback: TriggerCallback): void {
    this.installHook();

    // Watch the signal file directory
    const dir = join(this.repoDir, '.git');
    this.watcher = watch(dir, (_event, filename) => {
      if (filename !== 'nodyn-trigger-signal') return;
      if (!existsSync(this.signalFile)) return;

      try { unlinkSync(this.signalFile); } catch { /* race condition ok */ }

      void callback({
        source: 'git',
        payload: { hook: this.hook, repoDir: this.repoDir },
        timestamp: new Date().toISOString(),
      }).catch(() => {
        // Ignore callback failures; the trigger itself should remain active.
      });
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private installHook(): void {
    const hooksDir = join(this.repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, this.hook);
    const markerStart = '# >>> nodyn trigger';
    const markerEnd = '# <<< nodyn trigger';
    const snippet = `${markerStart}\ntouch "${this.signalFile}"\n${markerEnd}`;

    if (!existsSync(hookPath)) {
      const script = `#!/bin/sh\n${snippet}\n`;
      writeFileSync(hookPath, script, { mode: 0o755 });
      return;
    }

    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(markerStart)) {
      return;
    }

    const withShebang = existing.startsWith('#!') ? existing : `#!/bin/sh\n${existing}`;
    const separator = withShebang.endsWith('\n') ? '' : '\n';
    writeFileSync(hookPath, `${withShebang}${separator}${snippet}\n`, { mode: 0o755 });
  }
}
