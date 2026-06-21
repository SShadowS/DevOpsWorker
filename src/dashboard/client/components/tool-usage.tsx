import { signal } from '@preact/signals';
import type { DashboardSession } from '../../types.ts';

type SortKey = 'name' | string;
// null = execution order (matches the Timeline tab); a column key = explicit sort.
const sortColumn = signal<SortKey | null>(null);
const sortAsc = signal(true);

interface Props { session: DashboardSession; }

export function ToolUsage({ session }: Props) {
  const stages = session.telemetry.stages;
  const allTools = new Set<string>();
  for (const stage of stages) {
    if (stage.toolCalls) {
      for (const tool of Object.keys(stage.toolCalls)) allTools.add(tool);
    }
  }
  const toolNames = Array.from(allTools).sort();
  if (toolNames.length === 0) return <p class="empty-state">No tool usage data.</p>;

  // Preserve execution order (telemetry array order) — same as the Timeline tab.
  const rows = stages
    .filter((s) => s.toolCalls && Object.keys(s.toolCalls).length > 0)
    .map((s, order) => {
      const counts = s.toolCalls as Record<string, number>;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return { name: s.name, counts, total, order };
    });

  const col = sortColumn.value;
  const sorted = col === null
    ? rows // execution order
    : [...rows].sort((a, b) => {
        let cmp: number;
        if (col === 'name') cmp = a.name.localeCompare(b.name);
        else if (col === 'total') cmp = a.total - b.total;
        else cmp = (a.counts[col] ?? 0) - (b.counts[col] ?? 0);
        // Stable tie-break on execution order so equal cells keep Timeline order.
        if (cmp === 0) cmp = a.order - b.order;
        return sortAsc.value ? cmp : -cmp;
      });

  const maxPerTool: Record<string, number> = {};
  for (const tool of toolNames) maxPerTool[tool] = Math.max(0, ...rows.map((r) => r.counts[tool] ?? 0));
  const maxTotal = Math.max(0, ...rows.map((r) => r.total));

  function handleSort(col: SortKey) {
    if (sortColumn.value === col) {
      // Cycle: asc → desc → back to execution order.
      if (sortAsc.value) sortAsc.value = false;
      else { sortColumn.value = null; sortAsc.value = true; }
    } else { sortColumn.value = col; sortAsc.value = true; }
  }

  function cellOpacity(value: number, max: number): string {
    if (max === 0 || value === 0) return '0';
    return (value / max * 0.6).toFixed(2);
  }

  return (
    <div class="tool-usage">
      <table class="tool-table">
        <thead>
          <tr>
            <th class="tool-table__sortable" onClick={() => handleSort('name')}>Stage</th>
            {toolNames.map((t) => <th key={t} class="tool-table__sortable" onClick={() => handleSort(t)}>{t}</th>)}
            <th class="tool-table__sortable" onClick={() => handleSort('total')}>Total</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={`${row.name}-${row.order}`}>
              <td class="tool-table__name">{row.name}</td>
              {toolNames.map((t) => {
                const v = row.counts[t] ?? 0;
                return <td key={t} class="tool-table__cell" style={{ backgroundColor: `rgba(88, 166, 255, ${cellOpacity(v, maxPerTool[t] ?? 0)})` }}>{v || ''}</td>;
              })}
              <td class="tool-table__cell tool-table__total" style={{ backgroundColor: `rgba(88, 166, 255, ${cellOpacity(row.total, maxTotal)})` }}>{row.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
