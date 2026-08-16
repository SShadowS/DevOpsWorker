// ---------------------------------------------------------------------------
// Hash-based route state (arrival-efficiency fix, design-critique finding).
//
// No server routing exists for this SPA: server.ts serves index.html only at
// `/` and `/index.html` and returns 404 for every other path (checked before
// writing this — there is no catch-all). Encoding navigation state in the
// URL PATH would therefore break exactly the case this feature exists for: a
// pasted link opened in a fresh tab. The hash fragment is never sent to the
// server and survives both a hard reload and a brand-new tab, so that is
// what this module reads and writes.
//
// Deliberately generic: this module knows nothing about tabs, sections,
// windows, or populations — it only reads/writes an untyped bag of
// `key=value` pairs in `location.hash`, plus one small shared helper
// (`parseEnumParam`) for "is this string one of a fixed set of valid
// values". Each feature owns its own vocabulary next to the code that
// already defines it: the app-tab switcher's `ViewName` list lives in
// app.tsx, the Stats & Config tab's section/window/population lists live in
// stats-store.ts. That keeps this file a leaf with no imports of its own —
// stats-store.ts and app.tsx both import FROM here, nothing imports the
// other way, so there is no import cycle to reason about.
// ---------------------------------------------------------------------------

/** Reads the current hash as a param bag. `URLSearchParams` is itself total
 *  — malformed input never throws, it just yields fewer or emptier pairs —
 *  so this can't fail on garbage either. Returns an empty bag outside a
 *  browser (tests, or any non-DOM environment) rather than throwing. */
export function getRouteParams(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams();
  const hash = location.hash;
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** Validates a raw param value against a fixed list of valid strings —
 *  the one piece of parsing logic every route parser in this app shares.
 *  Total: a missing key or a value outside the list both return `null`
 *  rather than throwing or guessing, so a caller can fall back to whatever
 *  it considers "the URL said nothing" (a remembered choice, a hardcoded
 *  default). */
export function parseEnumParam<T extends string>(
  params: URLSearchParams,
  key: string,
  validValues: readonly T[],
): T | null {
  const raw = params.get(key);
  return raw !== null && (validValues as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Patches the given keys into the current hash — deleting a key whose value
 * is `undefined`, leaving every other key untouched — so independent
 * features (the app-tab switcher, the Stats tab's section/window/population)
 * can each update their own slice without clobbering another's.
 *
 * Uses `replaceState` by default. A control that changes on every click
 * (tab, section, window, population) must not spend one back-button step
 * per click, or the back button stops taking the operator where they
 * expect — see stats-view.tsx's module doc comment for why every caller in
 * this app currently chooses `replaceState` over `push: true`. No-ops when
 * the patch would not change the hash, so it never creates a redundant
 * history entry or fires a spurious `popstate`. Safe outside a browser: a
 * missing `location`/`history` makes this a no-op rather than a throw.
 */
export function updateRouteParams(patch: Record<string, string | undefined>, opts?: { push?: boolean }): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const params = getRouteParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const nextHash = query ? `#${query}` : '';
  const currentHash = location.hash === '#' ? '' : location.hash;
  if (nextHash === currentHash) return;
  const url = location.pathname + location.search + nextHash;
  if (opts?.push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}
