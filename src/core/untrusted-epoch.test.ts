import { describe, it, expect } from 'vitest';
import { approvalKey, approvalOrigin } from './untrusted-epoch.js';

const H = 'api.example.test';

describe('approval keys', () => {
  it('keys an approval by method and normalized host', () => {
    expect(approvalKey('post', 'API.Example.Test.')).toBe(`POST ${H}`);
  });

  it.each([
    ['https://API.Example.Test./a', H],
    ['https://api.example.test:443/a', H],
    ['http://api.example.test/a', `http://${H}`],
    ['http://api.example.test:80/a', `http://${H}`],
    ['http://API.example.test.:8080/a', `http://${H}:8080`],
    ['https://api.example.test:8443/a', `https://${H}:8443`],
    ['http://[::1]:3000/a', 'http://[::1]:3000'],
  ])('names the service of %s as %s', (url, origin) => {
    expect(approvalOrigin(new URL(url))).toBe(origin);
  });
});
