import { describe, it, expect } from 'vitest';
import { promptExpiry } from './time.js';

// A question's card names the time it has left only when it matters: nothing with an hour or more,
// whole minutes under an hour (rounded down: never more time than there is), seconds under a minute.
describe('promptExpiry', () => {
	it('an hour or more left: no number', () => {
		expect(promptExpiry(86_400)).toBeNull();
		expect(promptExpiry(86_399)).toBeNull();
		expect(promptExpiry(3600)).toBeNull();
	});

	it('under an hour: whole minutes, rounded down', () => {
		expect(promptExpiry(3599)).toEqual({ key: 'chat.prompt_expires_min', n: 59 });
		expect(promptExpiry(125)).toEqual({ key: 'chat.prompt_expires_min', n: 2 });
		expect(promptExpiry(119.9)).toEqual({ key: 'chat.prompt_expires_min', n: 1 });
		expect(promptExpiry(60)).toEqual({ key: 'chat.prompt_expires_min', n: 1 });
	});

	it('under a minute: seconds', () => {
		expect(promptExpiry(59)).toEqual({ key: 'chat.prompt_expires_s', n: 59 });
		expect(promptExpiry(7.9)).toEqual({ key: 'chat.prompt_expires_s', n: 7 });
		expect(promptExpiry(0)).toEqual({ key: 'chat.prompt_expires_s', n: 0 });
		expect(promptExpiry(-5)).toEqual({ key: 'chat.prompt_expires_s', n: 0 });
	});
});
