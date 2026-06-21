import type { ActionType } from '../types.ts';

/** Dispatch a pipeline action and return the assigned actionId so the caller can track its lifecycle. */
export async function dispatchAction(
  workItemId: number,
  type: ActionType,
  opts?: { feedback?: string; email?: string },
): Promise<number> {
  const res = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workItemId, type, ...opts, createdAt: new Date().toISOString() }),
  });
  if (!res.ok) {
    const body = await res.text();
    let message = `Action failed: ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      message = parsed.error ?? message;
    } catch {
      if (body) message = body;
    }
    throw new Error(message);
  }
  const data = await res.json() as { actionId: number };
  return data.actionId;
}
