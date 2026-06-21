import type { Signal } from '@preact/signals';
import type { StageProgress } from '../../types.ts';
import { stageNodeClass } from './stage-node-class.ts';

interface Props {
  stages: StageProgress[];
  rewindStage: Signal<string | null>;
}

export function StageProgression({ stages, rewindStage }: Props) {
  const targetStage = rewindStage.value;

  return (
    <div class="stage-bar">
      {stages.map((stage, i) => {
        const isRewindTarget = targetStage === stage.name;
        const isAfterTarget = targetStage
          ? stages.findIndex((s) => s.name === targetStage) < i
          : false;

        return (
          <>
            {i > 0 && <div class={`stage-connector stage-connector--${stages[i - 1]!.status}`} />}
            <div class="stage-column">
              <div
                class={stageNodeClass(stage, { isRewindTarget, isAfterTarget })}
                title={`${stage.label} (${stage.status})${stage.iterations ? ` — ${stage.iterations} iterations` : ''}`}
              >
                <div class="stage-node__circle">
                  {isRewindTarget && <span class="stage-node__icon">↩</span>}
                  {!isRewindTarget && stage.isCheckpoint && <span class="stage-node__icon">⏸</span>}
                  {!isRewindTarget && stage.isLoop && stage.iterations && stage.iterations > 1 && (
                    <span class="stage-node__count">x{stage.iterations}</span>
                  )}
                </div>
                <span class="stage-node__label">{stage.label}</span>
              </div>
              {stage.reviewer && (
                <div class="stage-reviewer">
                  <div class="stage-reviewer__stem" />
                  <div
                    class={`stage-reviewer__node stage-reviewer__node--${stage.reviewer.status}`}
                    title={`${stage.reviewer.label} (${stage.reviewer.status})`}
                  />
                  <span class={`stage-reviewer__label stage-reviewer__label--${stage.reviewer.status}`}>
                    {stage.reviewer.label}
                  </span>
                </div>
              )}
            </div>
          </>
        );
      })}
    </div>
  );
}
