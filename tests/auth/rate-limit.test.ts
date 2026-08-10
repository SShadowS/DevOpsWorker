import { describe, test, expect } from 'bun:test';
import { LoginRateLimiter } from '../../src/auth/rate-limit.ts';

describe('LoginRateLimiter', () => {
  test('locks after 5 failures, per key', () => {
    let clock = 1_000_000;
    const rl = new LoginRateLimiter(5, 60_000, () => clock);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('a@b.c|1.2.3.4')).toBe(true);
      rl.recordFailure('a@b.c|1.2.3.4');
    }
    expect(rl.check('a@b.c|1.2.3.4')).toBe(false);
    expect(rl.check('other@b.c|1.2.3.4')).toBe(true); // different key unaffected
  });

  test('lockout expires after the window', () => {
    let clock = 1_000_000;
    const rl = new LoginRateLimiter(5, 60_000, () => clock);
    for (let i = 0; i < 5; i++) rl.recordFailure('k');
    expect(rl.check('k')).toBe(false);
    clock += 60_001;
    expect(rl.check('k')).toBe(true);
  });

  test('success clears the counter', () => {
    const rl = new LoginRateLimiter(5, 60_000, () => 1_000_000);
    for (let i = 0; i < 4; i++) rl.recordFailure('k');
    rl.recordSuccess('k');
    for (let i = 0; i < 4; i++) rl.recordFailure('k');
    expect(rl.check('k')).toBe(true); // 4 fails since success, not 8
  });
});
