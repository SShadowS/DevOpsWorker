import { describe, test, expect } from 'bun:test';
import { stageNodeClass } from '../../src/dashboard/client/components/stage-node-class.ts';
import type { StageProgress } from '../../src/dashboard/types.ts';

function stage(overrides: Partial<StageProgress> = {}): StageProgress {
  return { name: 'planning', label: 'Plan', status: 'active', ...overrides };
}

describe('stageNodeClass', () => {
  test('reviewer phase adds the review-phase modifier', () => {
    const cls = stageNodeClass(stage({ activePhase: 'reviewer' }), { isRewindTarget: false, isAfterTarget: false });
    expect(cls).toContain('stage-node--active');
    expect(cls).toContain('stage-node--review-phase');
  });

  test('producer phase (no activePhase) has no review-phase modifier', () => {
    const cls = stageNodeClass(stage(), { isRewindTarget: false, isAfterTarget: false });
    expect(cls).not.toContain('stage-node--review-phase');
  });

  test('rewind flags still apply', () => {
    const cls = stageNodeClass(stage(), { isRewindTarget: true, isAfterTarget: true });
    expect(cls).toContain('stage-node--rewind-target');
    expect(cls).toContain('stage-node--rewind-dim');
  });
});
