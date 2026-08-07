import { describe, test, expect } from 'bun:test';
import {
  startScheduled,
  stopScheduled,
  guardedRunner,
  type ScheduledHandle,
} from '../../../src/cli/watch/scheduler.ts';
import type { ScheduledTask } from '../../../src/overlay/types.ts';

// ---------------------------------------------------------------------------
// Scheduler unit tests.
//
// No database, no network, no minute-long waits: the re-entrancy and
// error-containment behaviour is exercised by calling the guarded runner
// directly, and the two tests that need a real timer use sub-second intervals
// (`everyMinutes` accepts fractions).
// ---------------------------------------------------------------------------

/** A deferred promise, so a test can hold a task "in flight" deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const collectLog = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => { lines.push(m); } };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startScheduled — registration', () => {
  test('no overlay / no scheduled array: registers nothing and logs nothing', () => {
    const { lines, log } = collectLog();

    expect(startScheduled(undefined, { log })).toEqual([]);
    expect(startScheduled([], { log })).toEqual([]);

    // The no-overlay watcher must look exactly like it did before the scheduler
    // existed — including in its log.
    expect(lines).toEqual([]);
  });

  test('logs the registered task names and cadences', () => {
    const { lines, log } = collectLog();
    const handles = startScheduled(
      [
        { name: 'alpha', everyMinutes: 60, run: async () => {} },
        { name: 'beta', everyMinutes: 5, runAtStart: false, run: async () => {} },
      ],
      { log },
    );

    try {
      expect(handles.map((h) => h.name)).toEqual(['alpha', 'beta']);
      const registration = lines.find((l) => l.includes('registered'));
      expect(registration).toContain('2 background task(s)');
      expect(registration).toContain('alpha (every 60 min)');
      expect(registration).toContain('beta (every 5 min)');
    } finally {
      stopScheduled(handles);
    }
  });

  test('refuses a non-positive or non-finite interval instead of hot-looping', () => {
    const { lines, log } = collectLog();
    let ran = 0;
    const handles = startScheduled(
      [
        { name: 'nan', everyMinutes: Number.NaN, run: async () => { ran++; } },
        { name: 'zero', everyMinutes: 0, run: async () => { ran++; } },
        { name: 'negative', everyMinutes: -1, run: async () => { ran++; } },
      ],
      { log },
    );

    try {
      // setInterval(fn, NaN) would otherwise become a 1ms hot loop.
      expect(handles).toEqual([]);
      expect(ran).toBe(0);
      expect(lines.filter((l) => l.includes('NOT registered'))).toHaveLength(3);
      // Nothing was registered, so no registration summary is claimed.
      expect(lines.some((l) => l.includes('registered 1'))).toBe(false);
    } finally {
      stopScheduled(handles);
    }
  });

  test('runAtStart fires once immediately; omitting it does not', async () => {
    const { log } = collectLog();
    let eager = 0;
    let lazy = 0;
    const handles = startScheduled(
      [
        // Long cadence so only the startup run can be responsible.
        { name: 'eager', everyMinutes: 60, runAtStart: true, run: async () => { eager++; } },
        { name: 'lazy', everyMinutes: 60, run: async () => { lazy++; } },
      ],
      { log },
    );

    try {
      await tick();
      expect(eager).toBe(1);
      expect(lazy).toBe(0);
    } finally {
      stopScheduled(handles);
    }
  });
});

describe('guardedRunner — re-entrancy', () => {
  test('a run that outlives its interval does not get a second concurrent copy', async () => {
    const { lines, log } = collectLog();
    const gate = deferred();
    let starts = 0;
    const task: ScheduledTask = {
      name: 'slow',
      everyMinutes: 1,
      run: async () => { starts++; await gate.promise; },
    };
    const run = guardedRunner(task, log);

    const first = run();
    await tick();
    expect(starts).toBe(1);

    // Three more ticks arrive while the first is still in flight.
    await run();
    await run();
    await run();
    expect(starts).toBe(1);
    expect(lines.filter((l) => l.includes('still running from an earlier tick'))).toHaveLength(3);

    // Once it finishes, the guard reopens.
    gate.resolve();
    await first;
    await run();
    expect(starts).toBe(2);
  });

  test('the guard is per task — a slow task does not block a different one', async () => {
    const { log } = collectLog();
    const gate = deferred();
    let fastRuns = 0;

    const slow = guardedRunner(
      { name: 'slow', everyMinutes: 1, run: async () => { await gate.promise; } },
      log,
    );
    const fast = guardedRunner(
      { name: 'fast', everyMinutes: 1, run: async () => { fastRuns++; } },
      log,
    );

    const inFlight = slow();
    await tick();
    await fast();
    await fast();
    expect(fastRuns).toBe(2);

    gate.resolve();
    await inFlight;
  });

  test('the guard reopens after a throw, so one failure does not wedge the task', async () => {
    const { log } = collectLog();
    let runs = 0;
    const run = guardedRunner(
      {
        name: 'flaky',
        everyMinutes: 1,
        run: async () => { runs++; throw new Error('boom'); },
      },
      log,
    );

    await run();
    await run();
    expect(runs).toBe(2);
  });
});

describe('guardedRunner — error containment', () => {
  test('a throwing task neither rejects nor stops later ticks, and IS logged', async () => {
    const { lines, log } = collectLog();
    const seen: string[] = [];
    const run = guardedRunner(
      {
        name: 'nightly',
        everyMinutes: 1,
        run: async () => {
          seen.push('ran');
          if (seen.length === 1) throw new Error('first tick exploded');
        },
      },
      log,
    );

    // No rejection escapes — an unhandled one would take the watcher down.
    await expect(run()).resolves.toBeUndefined();
    await run();

    expect(seen).toHaveLength(2);
    const failure = lines.find((l) => l.includes('FAILED'));
    // Named, so a silent nightly job is distinguishable from one that never ran.
    expect(failure).toContain("'nightly'");
    expect(failure).toContain('first tick exploded');
    // ...and the following tick reported success.
    expect(lines.some((l) => l.includes("'nightly' finished"))).toBe(true);
  });

  test('a non-Error rejection is still logged with the task name', async () => {
    const { lines, log } = collectLog();
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const run = guardedRunner(
      { name: 'odd', everyMinutes: 1, run: async () => { throw 'a bare string'; } },
      log,
    );

    await run();
    const failure = lines.find((l) => l.includes('FAILED'));
    expect(failure).toContain("'odd'");
    expect(failure).toContain('a bare string');
  });
});

describe('startScheduled — ticking and shutdown', () => {
  test('the interval actually fires the task repeatedly', async () => {
    const { log } = collectLog();
    let runs = 0;
    // 0.0005 min = 30ms.
    const handles = startScheduled(
      [{ name: 'ticker', everyMinutes: 0.0005, run: async () => { runs++; } }],
      { log },
    );

    try {
      await new Promise((r) => setTimeout(r, 110));
      expect(runs).toBeGreaterThanOrEqual(2);
    } finally {
      stopScheduled(handles);
    }
  });

  test('a throwing task keeps ticking (the watcher stays scheduled)', async () => {
    const { lines, log } = collectLog();
    let runs = 0;
    const handles = startScheduled(
      [{
        name: 'always-fails',
        everyMinutes: 0.0005,
        run: async () => { runs++; throw new Error('nope'); },
      }],
      { log },
    );

    try {
      await new Promise((r) => setTimeout(r, 110));
      expect(runs).toBeGreaterThanOrEqual(2);
      expect(lines.filter((l) => l.includes('FAILED')).length).toBeGreaterThanOrEqual(2);
    } finally {
      stopScheduled(handles);
    }
  });

  test('stopScheduled clears every interval and is safe to call twice', async () => {
    const { log } = collectLog();
    let runs = 0;
    const handles: ScheduledHandle[] = startScheduled(
      [
        { name: 'a', everyMinutes: 0.0005, run: async () => { runs++; } },
        { name: 'b', everyMinutes: 0.0005, run: async () => { runs++; } },
      ],
      { log },
    );
    expect(handles).toHaveLength(2);

    stopScheduled(handles);
    stopScheduled(handles);

    const after = runs;
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toBe(after);
  });
});
