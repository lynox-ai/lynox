import { readdirSync, watch } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ITrigger, TriggerCallback, FileTriggerConfig } from '../../types/index.js';
import { channels } from '../observability.js';

export class FileTrigger implements ITrigger {
  readonly type = 'file';
  private readonly dir: string;
  private readonly glob: string | undefined;
  private readonly debounceMs: number;
  private watchers = new Map<string, ReturnType<typeof watch>>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFiles: Set<string> = new Set();
  private fallbackMode = false;

  constructor(config: FileTriggerConfig) {
    this.dir = resolve(config.dir);
    this.glob = config.glob;
    this.debounceMs = config.debounceMs ?? 500;
  }

  start(callback: TriggerCallback): void {
    const onEvent = (watchedDir: string) => (_event: string, filename: string | null): void => {
      if (!filename) return;
      const relativePath = watchedDir === this.dir
        ? filename
        : relative(this.dir, join(watchedDir, filename)).replaceAll('\\', '/');
      if (!relativePath || relativePath.startsWith('..')) return;
      if (relativePath.startsWith('.') || relativePath.includes('node_modules')) return;
      if (this.glob && !matchGlob(relativePath, this.glob)) return;
      this.pendingFiles.add(relativePath);
      this.scheduleBatch(callback);
      if (this.fallbackMode) {
        this.scheduleWatcherRefresh(callback);
      }
    };

    try {
      this.attachWatcher(this.dir, watch(this.dir, { recursive: true }, onEvent(this.dir)));
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
      if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || code === 'EINVAL') {
        this.fallbackMode = true;
        if (channels.fileWatcherFallback.hasSubscribers) {
          channels.fileWatcherFallback.publish({
            dir: this.dir,
            reason: `recursive watch unavailable (${code}), using per-directory polling`,
          });
        }
        this.refreshFallbackWatchers(callback);
      } else {
        throw err;
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcherRefreshTimer) {
      clearTimeout(this.watcherRefreshTimer);
      this.watcherRefreshTimer = null;
    }
    this.fallbackMode = false;
  }

  private scheduleBatch(callback: TriggerCallback): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const files = [...this.pendingFiles];
      this.pendingFiles.clear();
      if (files.length > 0) {
        void callback({
          source: 'file',
          payload: { dir: this.dir, files },
          timestamp: new Date().toISOString(),
        }).catch(() => {
          // Ignore callback failures; the caller owns recovery/logging.
        });
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private attachWatcher(dir: string, watcher: ReturnType<typeof watch>): void {
    this.watchers.set(dir, watcher);
    watcher.on('error', () => {
      // Ignore watcher runtime errors; trigger can be restarted externally.
    });
  }

  private scheduleWatcherRefresh(callback: TriggerCallback): void {
    if (this.watcherRefreshTimer) {
      clearTimeout(this.watcherRefreshTimer);
    }
    this.watcherRefreshTimer = setTimeout(() => {
      this.watcherRefreshTimer = null;
      this.refreshFallbackWatchers(callback);
    }, 100);
    this.watcherRefreshTimer.unref?.();
  }

  private refreshFallbackWatchers(callback: TriggerCallback): void {
    const desiredDirs = new Set(this.collectFallbackDirs(this.dir));

    for (const [dir, watcher] of this.watchers.entries()) {
      if (desiredDirs.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }

    for (const dir of desiredDirs) {
      if (this.watchers.has(dir)) continue;
      this.attachWatcher(dir, watch(dir, this.createFallbackHandler(dir, callback)));
    }
  }

  private createFallbackHandler(dir: string, callback: TriggerCallback): (event: string, filename: string | null) => void {
    return (event: string, filename: string | null) => {
      const handler = ((watchedDir: string) => (_event: string, file: string | null) => {
        if (!file) return;
        const relativePath = watchedDir === this.dir
          ? file
          : relative(this.dir, join(watchedDir, file)).replaceAll('\\', '/');
        if (!relativePath || relativePath.startsWith('..')) return;
        if (relativePath.startsWith('.') || relativePath.includes('node_modules')) return;
        if (this.glob && !matchGlob(relativePath, this.glob)) return;
        this.pendingFiles.add(relativePath);
        this.scheduleBatch(callback);
        this.scheduleWatcherRefresh(callback);
      })(dir);
      handler(event, filename);
    };
  }

  private collectFallbackDirs(root: string): string[] {
    const dirs = [root];
    let index = 0;
    while (index < dirs.length) {
      const current = dirs[index++];
      if (!current) continue;
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = readdirSync(current, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        dirs.push(join(current, entry.name));
      }
    }
    return dirs;
  }
}

/** Simple glob matching: supports *.ext and **\/ patterns */
function matchGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*');
  return new RegExp(`^${regex}$`).test(filename);
}
