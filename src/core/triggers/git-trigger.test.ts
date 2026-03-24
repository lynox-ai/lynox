import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TriggerCallback, TriggerEvent } from '../../types/index.js';

// Mock node:fs before importing GitTrigger
const mockClose = vi.fn();
const mockWatch = vi.fn(() => ({ close: mockClose }));
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('node:fs', () => ({
  watch: mockWatch,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  unlinkSync: mockUnlinkSync,
}));

const { GitTrigger } = await import('./git-trigger.js');

describe('GitTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('#!/bin/sh\n');
  });

  it('has type "git"', () => {
    const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
    expect(trigger.type).toBe('git');
  });

  describe('installHook (called by start)', () => {
    it('creates hooks directory with recursive option', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.git/hooks'),
        { recursive: true },
      );

      trigger.stop();
    });

    it('writes hook script at .git/hooks/{hook} with mode 0o755', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [hookPath, script, options] = mockWriteFileSync.mock.calls[0] as unknown[];
      expect(hookPath).toContain('.git/hooks/post-commit');
      expect(script).toContain('#!/bin/sh');
      expect(script).toContain('nodyn-trigger-signal');
      expect(options).toEqual({ mode: 0o755 });

      trigger.stop();
    });

    it('uses correct hook name for post-merge', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-merge' });
      trigger.start(vi.fn(() => Promise.resolve()));

      const [hookPath] = mockWriteFileSync.mock.calls[0] as unknown[];
      expect(hookPath).toContain('.git/hooks/post-merge');

      trigger.stop();
    });
  });

  describe('start', () => {
    it('watches .git directory', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      expect(mockWatch).toHaveBeenCalledTimes(1);
      const [dir] = mockWatch.mock.calls[0] as unknown[];
      expect(dir).toMatch(/\.git$/);

      trigger.stop();
    });

    it('fires callback when signal file is detected', () => {
      mockExistsSync.mockImplementation((path: unknown) => String(path).includes('nodyn-trigger-signal'));

      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      const events: TriggerEvent[] = [];
      const callback: TriggerCallback = async (event) => { events.push(event); };

      trigger.start(callback);

      // Get the watcher callback
      const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[1] as (event: string, filename: string) => void;
      watcherCallback('change', 'nodyn-trigger-signal');

      expect(events).toHaveLength(1);
      expect(events[0]!.source).toBe('git');
      expect((events[0]!.payload as any).hook).toBe('post-commit');
      expect(typeof events[0]!.timestamp).toBe('string');

      trigger.stop();
    });

    it('removes signal file after processing', () => {
      mockExistsSync.mockImplementation((path: unknown) => String(path).includes('nodyn-trigger-signal'));

      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[1] as (event: string, filename: string) => void;
      watcherCallback('change', 'nodyn-trigger-signal');

      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('nodyn-trigger-signal'));

      trigger.stop();
    });

    it('ignores other files in .git dir', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[1] as (event: string, filename: string) => void;
      watcherCallback('change', 'HEAD');
      watcherCallback('change', 'config');
      watcherCallback('change', 'index');

      expect(callback).not.toHaveBeenCalled();

      trigger.stop();
    });

    it('does not fire if signal file does not exist (race condition)', () => {
      mockExistsSync.mockReturnValue(false);

      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[1] as (event: string, filename: string) => void;
      watcherCallback('change', 'nodyn-trigger-signal');

      expect(callback).not.toHaveBeenCalled();

      trigger.stop();
    });

    it('swallows rejected callback promises from the signal watcher', async () => {
      mockExistsSync.mockImplementation((path: unknown) => String(path).includes('nodyn-trigger-signal'));

      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      const callback = vi.fn<TriggerCallback>().mockRejectedValue(new Error('boom'));

      trigger.start(callback);

      const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[1] as (event: string, filename: string) => void;
      watcherCallback('change', 'nodyn-trigger-signal');
      await Promise.resolve();

      expect(callback).toHaveBeenCalledTimes(1);

      trigger.stop();
    });
  });

  describe('default repoDir', () => {
    it('defaults repoDir to "." (resolved)', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      // The watched dir should end with .git (relative to cwd)
      const [dir] = mockWatch.mock.calls[0] as unknown[];
      expect(dir).toMatch(/\.git$/);

      trigger.stop();
    });
  });

  describe('custom repoDir', () => {
    it('uses custom repoDir for hook path and watch dir', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit', repoDir: '/custom/repo' });
      trigger.start(vi.fn(() => Promise.resolve()));

      const [hookPath] = mockWriteFileSync.mock.calls[0] as unknown[];
      expect(hookPath).toContain('/custom/repo/.git/hooks/post-commit');

      const [watchDir] = mockWatch.mock.calls[0] as unknown[];
      expect(watchDir).toContain('/custom/repo/.git');

      trigger.stop();
    });
  });

  describe('stop', () => {
    it('closes watcher', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      trigger.stop();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('is safe to call stop multiple times', () => {
      const trigger = new GitTrigger({ type: 'git', hook: 'post-commit' });
      trigger.start(vi.fn(() => Promise.resolve()));

      trigger.stop();
      expect(() => trigger.stop()).not.toThrow();
    });
  });
});
