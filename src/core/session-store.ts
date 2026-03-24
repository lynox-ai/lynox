import { Agent } from './agent.js';
import type { AgentConfig } from '../types/index.js';

export class SessionStore {
  private readonly sessions = new Map<string, Agent>();

  getOrCreate(sessionId: string, config: AgentConfig): Agent {
    let agent = this.sessions.get(sessionId);
    if (!agent) {
      agent = new Agent(config);
      this.sessions.set(sessionId, agent);
    }
    return agent;
  }

  get(sessionId: string): Agent | undefined {
    return this.sessions.get(sessionId);
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
