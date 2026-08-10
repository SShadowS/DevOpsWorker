/** In-memory login throttle: after `maxFails` failures for a key, block until
 *  `lockoutMs` has passed since the last failure. Keys are `email|ip`. State is
 *  per-process — good enough for one dashboard instance (spec). */
export class LoginRateLimiter {
  private fails = new Map<string, { count: number; lastFailAt: number }>();

  constructor(
    private readonly maxFails = 5,
    private readonly lockoutMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): boolean {
    const entry = this.fails.get(key);
    if (!entry || entry.count < this.maxFails) return true;
    if (this.now() - entry.lastFailAt > this.lockoutMs) {
      this.fails.delete(key);
      return true;
    }
    return false;
  }

  recordFailure(key: string): void {
    const entry = this.fails.get(key);
    if (entry) {
      entry.count += 1;
      entry.lastFailAt = this.now();
    } else {
      this.fails.set(key, { count: 1, lastFailAt: this.now() });
    }
  }

  recordSuccess(key: string): void {
    this.fails.delete(key);
  }
}
