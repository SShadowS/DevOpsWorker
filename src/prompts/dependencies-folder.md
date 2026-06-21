# Folder Names Don't Imply Boundaries

AL repos sometimes contain folders with unusual names — a leading dot, a name
like `.dependencies/`, `vendor/`, or a legacy label left over from a C/AL → AL
migration. **A folder name alone carries no architectural meaning.** Source files
inside such a folder are usually regular, compiled, shipped AL code belonging to
the SAME extension as the surrounding folders.

(If your codebase has a specific quirky-folder convention worth spelling out,
document it in the private overlay copy of this file —
`<PRIVATE_DIR>/prompts/dependencies-folder.md` — which overrides this one.)

## What this means

- An oddly-named in-repo folder is NOT automatically a read-only symbol cache,
  dependency package, vendored copy, or reference to an external app.
- Files in it are NOT necessarily from a separate extension. Editing them is the
  same as editing any other AL file in the extension — they compile into the same
  `.app`, ship in the same release, and run in the same tenant.
- Subscribing to events, extending tables, or adding fields in such files is a
  normal in-extension change — not a cross-extension boundary crossing.

## What NOT to do

- Do NOT treat these files as off-limits, vendored, or symbol-only based on the
  folder name alone.
- Do NOT plan work around the assumption that such a folder is "the base app"
  requiring a separate PR or coordination with another team.
- Do NOT flag changes to them as suspicious, architecturally wrong, no-op, or
  needing escalation purely because of where they live.

## How to distinguish

- **In-repo folder** (inside the target repo's app) → normal source code of the
  current extension. Edit freely.
- **Session-root siblings** (separate directories alongside the target repo) →
  separate companion extensions, read-only for cross-extension reference only.
