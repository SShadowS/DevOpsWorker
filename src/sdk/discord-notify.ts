/**
 * Discord webhook notifier for infrastructure errors.
 *
 * No-op when DISCORD_WEBHOOK_URL is unset, so dev/CI runs stay quiet.
 * Failures are swallowed and logged — never let a notification error
 * escalate into a pipeline error.
 */

export type Severity = 'error' | 'rate-limit' | 'warning';

export interface NotifyField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyOptions {
  title: string;
  description?: string;
  severity: Severity;
  fields?: NotifyField[];
  /** Makes the embed title clickable on mobile/desktop. */
  url?: string;
  /** Where the notification originated, shown in footer. */
  source: string;
}

const COLOR: Record<Severity, number> = {
  error: 0xE74C3C,
  'rate-limit': 0xF39C12,
  warning: 0xF1C40F,
};

const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4000;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const MAX_FIELDS = 25;

function clip(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export async function notifyDiscord(opts: NotifyOptions): Promise<void> {
  const url = process.env['DISCORD_WEBHOOK_URL'];
  if (!url) return;

  const embed = {
    title: clip(opts.title, TITLE_LIMIT),
    description: clip(opts.description, DESCRIPTION_LIMIT),
    color: COLOR[opts.severity],
    url: opts.url,
    fields: (opts.fields ?? []).slice(0, MAX_FIELDS).map(f => ({
      name: clip(f.name, FIELD_NAME_LIMIT) ?? '',
      value: clip(f.value || ' ', FIELD_VALUE_LIMIT) ?? ' ',
      inline: f.inline ?? true,
    })),
    footer: { text: clip(opts.source, 2048) ?? 'pipeline' },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[discord-notify] webhook ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[discord-notify] failed: ${msg}`);
  }
}

export interface PipelineErrorLike {
  type?: string;
  stage?: string;
  message: string;
}

/**
 * Convenience wrapper for PipelineError-shaped objects (or anything with
 * type/stage/message). Picks severity from `type === 'rate-limit'`.
 */
export async function notifyPipelineError(
  err: PipelineErrorLike,
  context: { source: string; url?: string; fields?: NotifyField[] },
): Promise<void> {
  const severity: Severity = err.type === 'rate-limit' ? 'rate-limit' : 'error';
  const stage = err.stage ?? 'unknown';
  const title = `[${err.type ?? 'error'}] ${stage}`;
  await notifyDiscord({
    title,
    description: err.message,
    severity,
    source: context.source,
    url: context.url,
    fields: context.fields,
  });
}
