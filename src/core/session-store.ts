import type { Session } from './session.js';
import type { Engine } from './engine.js';
import type { SessionOptions } from './session.js';

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  getOrCreate(sessionId: string, engine: Engine, opts?: SessionOptions): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = engine.createSession(opts);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
