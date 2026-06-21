import type { StageProgress } from '../../types.ts';

/** Build the parent stage-node className, including the review-phase modifier. */
export function stageNodeClass(
  stage: StageProgress,
  opts: { isRewindTarget: boolean; isAfterTarget: boolean },
): string {
  const classes = ['stage-node', `stage-node--${stage.status}`];
  if (stage.activePhase === 'reviewer') classes.push('stage-node--review-phase');
  if (opts.isRewindTarget) classes.push('stage-node--rewind-target');
  if (opts.isAfterTarget) classes.push('stage-node--rewind-dim');
  return classes.join(' ');
}
