import { describe, test, expect } from 'bun:test';
import { applyPipelineEdits, type PipelineEdit } from '../../src/overlay/stage-edit.ts';
import type { Stage, PipelineState, PipelineContext } from '../../src/types/pipeline.types.ts';

/** Minimal no-op stage with a given name, for topology tests. */
function mk(name: string): Stage {
  return {
    name,
    canRun: (_s: PipelineState) => true,
    execute: async (s: PipelineState, _c: PipelineContext) => ({ state: s }),
  };
}

const base = (): Stage[] => [mk('analyzer'), mk('planning'), mk('coding'), mk('draft-pr')];
const names = (stages: Stage[]) => stages.map((s) => s.name);

describe('applyPipelineEdits', () => {
  test('no edits returns the same topology (identity)', () => {
    const result = applyPipelineEdits(base(), []);
    expect(names(result)).toEqual(['analyzer', 'planning', 'coding', 'draft-pr']);
  });

  test('insertAfter places stage immediately after the anchor', () => {
    const edits: PipelineEdit[] = [{ op: 'insertAfter', anchor: 'planning', stage: mk('env-provision') }];
    expect(names(applyPipelineEdits(base(), edits))).toEqual([
      'analyzer', 'planning', 'env-provision', 'coding', 'draft-pr',
    ]);
  });

  test('insertBefore places stage immediately before the anchor', () => {
    const edits: PipelineEdit[] = [{ op: 'insertBefore', anchor: 'coding', stage: mk('env-provision') }];
    expect(names(applyPipelineEdits(base(), edits))).toEqual([
      'analyzer', 'planning', 'env-provision', 'coding', 'draft-pr',
    ]);
  });

  test('replace swaps the anchor stage in place', () => {
    const edits: PipelineEdit[] = [{ op: 'replace', anchor: 'coding', stage: mk('coding-proprietary') }];
    expect(names(applyPipelineEdits(base(), edits))).toEqual([
      'analyzer', 'planning', 'coding-proprietary', 'draft-pr',
    ]);
  });

  test('remove drops the anchor stage', () => {
    const edits: PipelineEdit[] = [{ op: 'remove', anchor: 'draft-pr' }];
    expect(names(applyPipelineEdits(base(), edits))).toEqual(['analyzer', 'planning', 'coding']);
  });

  test('edits apply sequentially, later anchors resolve against the mutated list', () => {
    const edits: PipelineEdit[] = [
      { op: 'insertAfter', anchor: 'planning', stage: mk('env-provision') },
      { op: 'insertAfter', anchor: 'env-provision', stage: mk('bc-activation') },
    ];
    expect(names(applyPipelineEdits(base(), edits))).toEqual([
      'analyzer', 'planning', 'env-provision', 'bc-activation', 'coding', 'draft-pr',
    ]);
  });

  test('missing anchor fails loud (never silent misalignment)', () => {
    const edits: PipelineEdit[] = [{ op: 'insertAfter', anchor: 'does-not-exist', stage: mk('x') }];
    expect(() => applyPipelineEdits(base(), edits)).toThrow(/anchor.*does-not-exist/i);
  });

  test('producing a duplicate stage name fails loud', () => {
    const edits: PipelineEdit[] = [{ op: 'insertAfter', anchor: 'coding', stage: mk('planning') }];
    expect(() => applyPipelineEdits(base(), edits)).toThrow(/duplicate/i);
  });

  test('does not mutate the input array', () => {
    const input = base();
    applyPipelineEdits(input, [{ op: 'remove', anchor: 'coding' }]);
    expect(names(input)).toEqual(['analyzer', 'planning', 'coding', 'draft-pr']);
  });
});
