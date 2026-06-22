import { symlink, rename, rm, copyFile, lstat, cp, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';

/** Symlink type for directories: junction on Windows (no admin needed), default on Linux */
const dirSymlinkType = platform() === 'win32' ? 'junction' : undefined;

/** Symlink type for files: 'file' on Windows (with copy fallback), default on Linux */
const fileSymlinkType = platform() === 'win32' ? 'file' : undefined;

// ---------------------------------------------------------------------------
// Agent workspace staging — symlinks agent CLAUDE.md / .claude/ into cwd
// ---------------------------------------------------------------------------

export interface StagedWorkspace {
  /** Symlink (or copy) paths created in targetCwd */
  links: string[];
  /** Paths of backed-up originals (if any) */
  backups: string[];
  /** Removes symlinks, restores backups. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

/**
 * Stage an agent's CLAUDE.md and .claude/ directory into the target cwd
 * so that the Claude Agent SDK's settingSources loader can find them.
 *
 * - `.claude/` → junction symlink (works without admin on Windows)
 * - `CLAUDE.md` → file symlink with fallback to copy (file symlinks need
 *   Developer Mode on Windows)
 * - If the target already has CLAUDE.md or .claude/, they are backed up
 *   and restored on cleanup.
 *
 * **Private overlay (`overlayDir`):** when a `private/agents/<name>/` directory
 * is supplied, its proprietary assets are merged on top of the base agent:
 * - `overlayDir/.claude/` → the staged `.claude/` becomes a real (copied) dir =
 *   base `.claude/` with the overlay's contents copied over it (overlay wins on
 *   name clash). A copy (not a junction) is used so cleanup can safely `rm -rf`
 *   it without risk of following a junction into the tracked source tree.
 * - `overlayDir/CLAUDE.md` → fully REPLACES the base CLAUDE.md (staged as a real
 *   copied file, never a symlink into the tracked source tree).
 * - `overlayDir/CLAUDE.append.md` → appended to the base CLAUDE.md (staged as a
 *   real concatenated file instead of a symlink).
 *   Replace and append are mutually exclusive: an overlay `CLAUDE.md` wins and
 *   any `CLAUDE.append.md` alongside it is ignored (with a warning). Append only
 *   augments the PUBLIC base CLAUDE.md.
 * With no overlay the fast junction/symlink path is used, unchanged.
 */
export async function stageAgentWorkspace(
  agentSourceDir: string,
  targetCwd: string,
  overlayDir?: string,
): Promise<StagedWorkspace> {
  const links: string[] = [];
  const backups: string[] = [];

  const overlayClaudeDir = overlayDir ? join(overlayDir, '.claude') : undefined;
  const hasOverlayClaude = !!overlayClaudeDir && existsSync(overlayClaudeDir);
  const overlayAppend = overlayDir ? join(overlayDir, 'CLAUDE.append.md') : undefined;
  const hasOverlayAppend = !!overlayAppend && existsSync(overlayAppend);

  /** Back up an existing target (real dir/file → rename to .bak; stale link → remove). */
  async function backupTarget(target: string, backupPath: string): Promise<void> {
    if (!existsSync(target)) return;
    const isLink = (await lstat(target)).isSymbolicLink();
    if (isLink) {
      // Stale junction/symlink from a previous run whose cleanup failed — remove it.
      // The original (if any) already lives at backupPath.
      await rm(target, { force: true, recursive: true });
      if (existsSync(backupPath)) backups.push(backupPath);
    } else {
      // Real dir/file — back it up. Remove any stale backup first (Windows rename
      // fails with EPERM if the destination exists).
      if (existsSync(backupPath)) await rm(backupPath, { force: true, recursive: true });
      await rename(target, backupPath);
      backups.push(backupPath);
    }
  }

  // --- Stage .claude/ directory ---
  const claudeDirSource = join(agentSourceDir, '.claude');
  const claudeDirTarget = join(targetCwd, '.claude');

  if (existsSync(claudeDirSource) || hasOverlayClaude) {
    await backupTarget(claudeDirTarget, join(targetCwd, '.claude.bak'));

    if (hasOverlayClaude) {
      // Copy-merge: base first, overlay copied over (overlay wins on clash).
      await mkdir(claudeDirTarget, { recursive: true });
      if (existsSync(claudeDirSource)) {
        await cp(claudeDirSource, claudeDirTarget, { recursive: true });
      }
      await cp(overlayClaudeDir!, claudeDirTarget, { recursive: true, force: true });
    } else {
      await symlink(claudeDirSource, claudeDirTarget, dirSymlinkType);
    }
    links.push(claudeDirTarget);
  }

  // --- Stage CLAUDE.md file ---
  const claudeMdSource = join(agentSourceDir, 'CLAUDE.md');
  const claudeMdTarget = join(targetCwd, 'CLAUDE.md');
  const overlayClaudeMd = overlayDir ? join(overlayDir, 'CLAUDE.md') : undefined;
  const hasOverlayClaudeMd = !!overlayClaudeMd && existsSync(overlayClaudeMd);

  // Replace and append are mutually exclusive modes: an overlay CLAUDE.md OWNS
  // the file, so an overlay CLAUDE.append.md alongside it is ignored (+ warned).
  // CLAUDE.append.md only augments the PUBLIC base.
  if (hasOverlayClaudeMd && hasOverlayAppend) {
    console.warn(
      `[overlay] agent dir ${overlayDir}: both CLAUDE.md (replace) and ` +
      `CLAUDE.append.md present — append ignored; fold it into CLAUDE.md.`,
    );
  }
  const applyAppend = hasOverlayAppend && !hasOverlayClaudeMd;

  // Append requires a public base CLAUDE.md to augment — if there's neither a
  // base nor an overlay CLAUDE.md, this block is skipped and a lone overlay
  // CLAUDE.append.md is silently ignored (preserves prior behavior).
  if (existsSync(claudeMdSource) || hasOverlayClaudeMd) {
    await backupTarget(claudeMdTarget, join(targetCwd, 'CLAUDE.md.bak'));

    if (applyAppend) {
      // Real concatenated file: public base CLAUDE.md + overlay append.
      const base = await readFile(claudeMdSource, 'utf8');
      const extra = await readFile(overlayAppend!, 'utf8');
      await writeFile(claudeMdTarget, `${base}\n\n${extra}`);
    } else if (hasOverlayClaudeMd) {
      // Overlay fully replaces — copy verbatim (real file, never a symlink into
      // the tracked source tree, consistent with the .claude/ copy-merge rule).
      await copyFile(overlayClaudeMd!, claudeMdTarget);
    } else {
      try {
        await symlink(claudeMdSource, claudeMdTarget, fileSymlinkType);
      } catch {
        // File symlinks need Developer Mode on Windows — fall back to copy
        await copyFile(claudeMdSource, claudeMdTarget);
      }
    }
    links.push(claudeMdTarget);
  }

  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    // Remove staged links/copies (real copied dirs and symlinks alike)
    for (const link of links) {
      try {
        await rm(link, { force: true, recursive: true });
      } catch {
        // Swallow — cleanup must never throw
      }
    }

    // Restore backups
    for (const backup of backups) {
      try {
        const originalPath = backup
          .replace(/\.claude\.bak$/, '.claude')
          .replace(/CLAUDE\.md\.bak$/, 'CLAUDE.md');
        await rename(backup, originalPath);
      } catch {
        // Swallow — cleanup must never throw
      }
    }
  }

  return { links, backups, cleanup };
}
