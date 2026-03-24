import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../types/index.js';

vi.mock('./agent.js', () => {
  return {
    Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>, config: AgentConfig) {
      this.config = config;
      this._isMockAgent = true;
    }),
  };
});

import { SessionStore } from './session-store.js';

const makeConfig = (name: string): AgentConfig => ({
  name,
  model: 'claude-opus-4-6',
});

describe('SessionStore', () => {
  describe('getOrCreate', () => {
    it('creates a new agent for unknown session ID', () => {
      const store = new SessionStore();
      const config = makeConfig('agent-1');
      const agent = store.getOrCreate('session-1', config);
      expect(agent).toBeDefined();
      expect((agent as unknown as { _isMockAgent: boolean })._isMockAgent).toBe(true);
    });

    it('returns the same agent for the same session ID', () => {
      const store = new SessionStore();
      const config = makeConfig('agent-1');
      const agent1 = store.getOrCreate('session-1', config);
      const agent2 = store.getOrCreate('session-1', config);
      expect(agent1).toBe(agent2);
    });

    it('does not create a new agent on second call with same ID', () => {
      const store = new SessionStore();
      const config1 = makeConfig('first');
      const config2 = makeConfig('second');
      const agent1 = store.getOrCreate('s1', config1);
      const agent2 = store.getOrCreate('s1', config2);
      expect(agent1).toBe(agent2);
      // Config from first call is used, second is ignored
      expect((agent1 as unknown as { config: AgentConfig }).config.name).toBe('first');
    });
  });

  describe('reset', () => {
    it('removes session so next getOrCreate creates fresh agent', () => {
      const store = new SessionStore();
      const config = makeConfig('agent-1');
      const agent1 = store.getOrCreate('session-1', config);
      store.reset('session-1');
      const agent2 = store.getOrCreate('session-1', config);
      expect(agent2).not.toBe(agent1);
    });

    it('does not affect other sessions', () => {
      const store = new SessionStore();
      const agent1 = store.getOrCreate('s1', makeConfig('a'));
      const agent2 = store.getOrCreate('s2', makeConfig('b'));
      store.reset('s1');
      const agent2Again = store.getOrCreate('s2', makeConfig('b'));
      expect(agent2Again).toBe(agent2);
    });

    it('is no-op for unknown session ID', () => {
      const store = new SessionStore();
      // Should not throw
      store.reset('nonexistent');
    });
  });

  describe('different session IDs', () => {
    it('get different agents', () => {
      const store = new SessionStore();
      const agentA = store.getOrCreate('session-a', makeConfig('a'));
      const agentB = store.getOrCreate('session-b', makeConfig('b'));
      expect(agentA).not.toBe(agentB);
    });
  });

  describe('get', () => {
    it('returns undefined for unknown session ID', () => {
      const store = new SessionStore();
      expect(store.get('no-such-session')).toBeUndefined();
    });

    it('returns the agent for an existing session', () => {
      const store = new SessionStore();
      const agent = store.getOrCreate('session-x', makeConfig('x'));
      expect(store.get('session-x')).toBe(agent);
    });

    it('returns undefined after reset', () => {
      const store = new SessionStore();
      store.getOrCreate('session-y', makeConfig('y'));
      store.reset('session-y');
      expect(store.get('session-y')).toBeUndefined();
    });
  });
});
