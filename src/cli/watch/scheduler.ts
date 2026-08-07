import type { ScheduledTask } from '../../overlay/types.ts';
import { log as defaultLog } from './watch-logger.ts';

// ---------------------------------------------------------------------------
// Generic interval scheduler for overlay-supplied background tasks.
//
// Lives beside the watcher's other extracted concerns rather than inside
// watch.ts, which is already long and carries several unrelated jobs. Keeping
// it here also makes it testable without starting a watcher: everything below
// is pure except the two `setInterval`/`clearInterval` calls, and the logger is
// injectable.
//
// The core deliberately knows NOTHING about what a task does. It owns
// registration, re-entrancy, error containment and shutdown; the overlay owns
// the work (`OverlayManifest.scheduled`).
// ---------------------------------------------------------------------------

/** A registered task's timer, handed to the watcher's shutdown handler. */
export interface ScheduledHandle {
  name: string;
  timer: ReturnType<typeof setInterval>;
}

export interface SchedulerOptions {
  /** Log sink. Injected by tests; defaults to the shared watcher logger. */
  log?: (message: string) => void;
}

const describe = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);

/**
 * Wrap a task's `run` so that a tick cannot overlap the previous one, and a
 * throw cannot escape.
 *
 * **Overlap is a correctness problem, not a tidiness one.** A task whose run
 * outlives its interval would otherwise get a second concurrent copy, and the
 * two race whatever external state the task checks before acting — each sees
 * "no work in flight" because neither has finished recording that it started.
 * For anything that spends money or writes rows on that check, that is a
 * duplicated side effect, not a duplicated log line. The guard is a per-task
 * closure, so one slow task never blocks another.
 *
 * **Errors are logged, never rethrown.** An unhandled rejection out of an
 * interval callback takes the watcher process down; but a task that fails
 * silently is indistinguishable from one that never ran, which is the failure
 * mode of every scheduled job nobody notices. So: caught, named, logged.
 *
 * Exported for tests — production reaches it only through `startScheduled`.
 */
export function guardedRunner(
  task: ScheduledTask,
  log: (message: string) => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    // Set synchronously before the first `await`, so two ticks in the same turn
    // of the loop cannot both pass this check.
    if (running) {
      log(`Scheduler: '${task.name}' is still running from an earlier tick — skipping this one`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    log(`Scheduler: '${task.name}' starting`);
    try {
      await task.run();
      log(`Scheduler: '${task.name}' finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (err) {
      log(`Scheduler: '${task.name}' FAILED after ${Math.round((Date.now() - startedAt) / 1000)}s: ${describe(err)}`);
    } finally {
      running = false;
    }
  };
}

/**
 * Register every task in `tasks` on its own interval and return the handles.
 *
 * Returns `[]` and logs nothing when there are no tasks — with no overlay
 * installed (or an overlay that declares none) the watcher must look exactly
 * like it did before this existed. When there ARE tasks, registration is logged
 * with names and cadences, so an operator can tell from the watcher log whether
 * scheduling is live at all rather than inferring it from silence.
 *
 * The caller owns the returned handles and must pass them to `stopScheduled`
 * from its shutdown path.
 */
export function startScheduled(
  tasks: ScheduledTask[] | undefined,
  opts: SchedulerOptions = {},
): ScheduledHandle[] {
  const log = opts.log ?? defaultLog;
  const handles: ScheduledHandle[] = [];
  const registered: string[] = [];
  const atStart: (() => Promise<void>)[] = [];

  for (const task of tasks ?? []) {
    const ms = task.everyMinutes * 60_000;
    // `setInterval(fn, NaN)` silently becomes a 1ms hot loop, and a negative
    // interval does the same. Refuse loudly instead.
    if (!Number.isFinite(ms) || ms <= 0) {
      log(`Scheduler: task '${task.name}' NOT registered — everyMinutes must be a positive finite number (got ${task.everyMinutes})`);
      continue;
    }
    const tick = guardedRunner(task, log);
    handles.push({ name: task.name, timer: setInterval(tick, ms) });
    registered.push(`${task.name} (every ${task.everyMinutes} min${task.runAtStart ? ', plus once at startup' : ''})`);
    if (task.runAtStart) atStart.push(tick);
  }

  if (registered.length > 0) {
    log(`Scheduler: registered ${registered.length} background task(s): ${registered.join(', ')}`);
  }
  // Fired after the registration log so the log records what is scheduled even
  // if a startup run blocks for a long time. Deliberately not awaited — the
  // watcher's poll loop must not wait on a background task.
  for (const tick of atStart) void tick();

  return handles;
}

/** Clear every registered interval. Safe to call twice. */
export function stopScheduled(handles: ScheduledHandle[]): void {
  for (const h of handles) clearInterval(h.timer);
}
