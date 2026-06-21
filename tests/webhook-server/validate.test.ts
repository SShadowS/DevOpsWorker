import { describe, test, expect } from 'bun:test';
import { validateSignature } from '../../src/webhook-server/validate.ts';
import * as crypto from 'crypto';

describe('validateSignature', () => {
  const secret = 'test-secret';
  const payload = '{"eventType":"git.pullrequest.created"}';

  function sign(body: string, key: string): string {
    const hmac = crypto.createHmac('sha1', key).update(body, 'utf8').digest('base64');
    return `sha1=${hmac}`;
  }

  test('returns true when signature matches', () => {
    const sig = sign(payload, secret);
    expect(validateSignature(payload, sig, secret)).toBe(true);
  });

  test('returns false when signature does not match', () => {
    expect(validateSignature(payload, 'sha1=badsignature', secret)).toBe(false);
  });

  test('returns false when no signature provided', () => {
    expect(validateSignature(payload, null, secret)).toBe(false);
  });

  test('returns true when no secret configured (skip validation)', () => {
    expect(validateSignature(payload, null, undefined)).toBe(true);
  });

  test('returns false when signature has wrong prefix', () => {
    expect(validateSignature(payload, 'md5=something', secret)).toBe(false);
  });
});
