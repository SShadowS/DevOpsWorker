import type { DashboardSession } from '../../types.ts';
import type { StageTelemetry } from '../../../types/pipeline.types.ts';
import { formatDurationDetailed as formatDuration } from '../format.ts';

interface Props { session: DashboardSession; }

/** Compact token count: 1234 → "1.2k", 1234567 → "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Fraction of prompt tokens served from cache, 0..100, or null if no token data. */
function cacheHitPct(t: StageTelemetry['tokens']): number | null {
  if (!t) return null;
  const prompt = t.input + t.cacheRead + t.cacheCreation;
  if (prompt === 0) return null;
  return (t.cacheRead / prompt) * 100;
}

const SUBTYPE_LABEL: Record<string, string> = {
  error_max_turns: 'max turns',
  error_max_budget_usd: 'max budget',
  error_max_structured_output_retries: 'schema retries',
  error_during_execution: 'error',
};

function StatusBadge({ subtype }: { subtype?: string }) {
  if (!subtype) return <span class="telemetry-table__muted">-</span>;
  if (subtype === 'success') return <span class="telemetry-badge telemetry-badge--ok">ok</span>;
  return <span class="telemetry-badge telemetry-badge--err">{SUBTYPE_LABEL[subtype] ?? subtype}</span>;
}

export function TelemetryTable({ session }: Props) {
  const stages = session.telemetry.stages;
  if (stages.length === 0) return <p class="empty-state">No telemetry data.</p>;

  const totalTokens = stages.reduce(
    (sum, s) => sum + (s.tokens ? s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation : 0),
    0,
  );

  return (
    <div class="telemetry">
      <div class="telemetry__totals">
        <span>Total cost: <strong>${session.telemetry.totalCostUsd.toFixed(2)}</strong></span>
        <span>Total duration: <strong>{formatDuration(session.telemetry.totalDurationMs)}</strong></span>
        {totalTokens > 0 && <span>Total tokens: <strong>{fmtTokens(totalTokens)}</strong></span>}
      </div>
      <table class="telemetry-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Cost</th>
            <th>Duration</th>
            <th>Turns</th>
            <th>Tokens (in/out)</th>
            <th title="Share of prompt tokens served from cache">Cache</th>
            <th>Status</th>
            <th>Model</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => {
            const cache = cacheHitPct(s.tokens);
            return (
              <tr key={`${s.name}-${i}`}>
                <td class="telemetry-table__name">{s.name}</td>
                <td>${s.costUsd.toFixed(3)}</td>
                <td>{formatDuration(s.durationMs)}</td>
                <td>{s.turns ?? '-'}</td>
                <td>
                  {s.tokens
                    ? `${fmtTokens(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation)} / ${fmtTokens(s.tokens.output)}`
                    : <span class="telemetry-table__muted">-</span>}
                </td>
                <td>{cache != null ? `${cache.toFixed(0)}%` : <span class="telemetry-table__muted">-</span>}</td>
                <td><StatusBadge subtype={s.subtype} /></td>
                <td>{s.model ?? '-'}</td>
                <td class="telemetry-table__time">
                  {s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : s.timestamp ? new Date(s.timestamp).toLocaleTimeString() : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
