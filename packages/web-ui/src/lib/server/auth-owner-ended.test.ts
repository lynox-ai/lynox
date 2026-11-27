import { describe, it, expect, afterEach } from 'vitest';
import { ownerSession, readSessionToken, createSessionToken, createLinkCode, consumeLinkCode, loginSession, OWNER_SESSION_PRINCIPAL } from './auth.js';

/**
 * The web UI's half of ending the owner's sessions: it reads the live generation the engine
 * published in this process (core `src/core/owner-sessions.ts`), mints owner sessions in it, and
 * refuses an owner session of any other.
 */
const KEY = Symbol.for('lynox.ownerSessionsGeneration');
const SECRET = 'web-ui-owner-ended-fixture';
const published = globalThis as Record<symbol, unknown>;
const genOf = (token: string): number | undefined => {
	const part = token.split('.')[1];
	if (part === undefined || token.split('.').length < 4) return undefined;
	return (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { gen?: number }).gen ?? 0;
};

describe('owner sessions and the live generation', () => {
	afterEach(() => { delete published[KEY]; });

	it('mints and lets in generation 0 while nothing is published, with the bytes of today', () => {
		const token = ownerSession(SECRET).token;
		expect(genOf(token)).toBe(0);
		expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))).toEqual({ v: 1, kind: 'owner' });
		expect(readSessionToken(token, SECRET)).not.toBeNull();
	});

	it('mints an owner session in the published generation, in both mints, and lets only that one in', () => {
		const gen0 = ownerSession(SECRET).token;
		const bare = createSessionToken(SECRET);
		published[KEY] = () => 3;
		const gen3 = ownerSession(SECRET).token;
		expect(genOf(gen3)).toBe(3);
		expect(genOf(createSessionToken(SECRET, OWNER_SESSION_PRINCIPAL))).toBe(3);
		expect(readSessionToken(gen3, SECRET)).not.toBeNull();
		expect(readSessionToken(gen0, SECRET)).toBeNull();
		expect(readSessionToken(bare, SECRET)).toBeNull();
		published[KEY] = () => 2;
		expect(readSessionToken(gen3, SECRET)).toBeNull();
	});

	it('refuses every owner session when the published reader throws or answers no generation', () => {
		const token = ownerSession(SECRET).token;
		for (const reader of [() => { throw new Error('closed'); }, () => 'soon', () => -1, () => 1.5]) {
			published[KEY] = reader;
			expect(readSessionToken(token, SECRET)).toBeNull();
		}
	});

	it('mints a mandate login without a generation, and lets it in whatever the owner generation is', () => {
		published[KEY] = () => 4;
		const now = Math.floor(Date.now() / 1000);
		const login = loginSession(SECRET, { kind: 'mandate', email: 'helper@example.invalid', display: 'Helper', mandate_id: 'TEST-M-1', mandate_expires_at: new Date((now + 3600) * 1000).toISOString() });
		expect(login).not.toBeNull();
		expect(JSON.parse(Buffer.from(login!.token.split('.')[1]!, 'base64url').toString('utf8'))).not.toHaveProperty('gen');
		expect(readSessionToken(login!.token, SECRET)?.principal?.kind).toBe('mandate');
	});

	it('refuses a link code made in a generation that has since been ended, and takes one made in the live one', () => {
		published[KEY] = () => 1;
		const before = createLinkCode();
		published[KEY] = () => 2;
		expect(consumeLinkCode(before)).toBe(false);
		const after = createLinkCode();
		expect(consumeLinkCode(after)).toBe(true);
	});
});
