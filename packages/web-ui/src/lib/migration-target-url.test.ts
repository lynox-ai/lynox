import { describe, it, expect } from 'vitest';
import { isPrivateIP } from '../../../../src/core/network-guard.js';
import { isPrivateAddressLiteral, isValidTargetUrl } from './migration-target-url.js';

// The wizard checks a target address by the engine's rule before it sends it: what the engine would
// turn down (http, a local, private or link-local address) does not go out, and what it takes passes.

const ADDRESSES = [
	'127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '172.32.0.1', '192.168.1.5', '169.254.169.254',
	'100.64.0.1', '100.128.0.1', '198.18.0.1', '192.0.0.8', '0.0.0.0', '224.0.0.1', '8.8.8.8', '203.0.113.7', '1.1.1.1',
	'::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
	'::ffff:8.8.8.8', '64:ff9b::a00:1', '64:ff9b::808:808', '2002:a00:1::', '2002:808:808::', '64:ff9b:1::1', '2001:4860:4860::8888',
];

describe('the wizard\'s check of a migration target', () => {
	it('judges an address literal as the engine\'s network guard does', () => {
		for (const a of ADDRESSES) expect(isPrivateAddressLiteral(a), a).toBe(isPrivateIP(a));
	});

	it('takes only https to a host that is not local or private', () => {
		for (const url of ['https://target.example.com', 'https://your-name.lynox.cloud', 'https://8.8.8.8', 'https://[2001:4860:4860::8888]:8443']) expect(isValidTargetUrl(url), url).toBe(true);
		for (const url of [
			'http://target.example.com', 'http://localhost', 'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]',
			'https://10.0.0.5', 'https://192.168.1.5', 'https://169.254.169.254', 'https://[fe80::1]', 'https://[::ffff:192.168.1.5]',
			'https://0x7f.1', 'ftp://example.com', 'not a url', '',
		]) expect(isValidTargetUrl(url), url).toBe(false);
	});
});
