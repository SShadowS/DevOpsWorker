import type { Stage, PipelineDefinition } from '../types/pipeline.types.ts';

/**
 * Declarative pipeline edit anchored on a stage's stable `.name`.
 *
 * The overlay system uses this instead of a raw `(base: Stage[]) => Stage[]`
 * transform: index-based array surgery in a private manifest misaligns silently
 * when the core reorders or inserts stages. Name anchors survive structural
 * changes to the core pipeline; a missing anchor throws instead of corrupting
 * topology.
 */
export type PipelineEdit =
  | { op: 'insertAfter'; anchor: string; stage: Stage }
  | { op: 'insertBefore'; anchor: string; stage: Stage }
  | { op: 'replace'; anchor: string; stage: Stage }
  | { op: 'remove'; anchor: string };

function anchorIndex(stages: Stage[], op: PipelineEdit['op'], anchor: string): number {
  const idx = stages.findIndex((s) => s.name === anchor);
  if (idx === -1) {
    throw new Error(
      `Pipeline edit '${op}' references anchor stage '${anchor}', but no stage with that name ` +
        `exists in the pipeline. Available: ${stages.map((s) => s.name).join(', ')}`,
    );
  }
  return idx;
}

/**
 * Apply a sequence of declarative edits to a pipeline, returning a NEW array.
 *
 * - Edits apply in order; each anchor resolves against the already-mutated list.
 * - A missing anchor throws (fail loud — never a silent misalignment).
 * - A resulting duplicate stage name throws (duplicate names break rewind logic).
 * - The input array is never mutated.
 */
export function applyPipelineEdits(base: PipelineDefinition, edits: PipelineEdit[]): PipelineDefinition {
  let stages: Stage[] = [...base];

  for (const edit of edits) {
    const idx = anchorIndex(stages, edit.op, edit.anchor);
    switch (edit.op) {
      case 'insertAfter':
        stages = [...stages.slice(0, idx + 1), edit.stage, ...stages.slice(idx + 1)];
        break;
      case 'insertBefore':
        stages = [...stages.slice(0, idx), edit.stage, ...stages.slice(idx)];
        break;
      case 'replace':
        stages = [...stages.slice(0, idx), edit.stage, ...stages.slice(idx + 1)];
        break;
      case 'remove':
        stages = [...stages.slice(0, idx), ...stages.slice(idx + 1)];
        break;
    }
  }

  const seen = new Set<string>();
  for (const s of stages) {
    if (seen.has(s.name)) {
      throw new Error(
        `Pipeline edits produced a duplicate stage name '${s.name}'. Stage names must be unique ` +
          `(rewind and checkpoint logic key off them).`,
      );
    }
    seen.add(s.name);
  }

  return stages;
}
