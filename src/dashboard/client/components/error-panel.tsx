interface Props {
  error: { type: string; stage: string; message: string; timestamp: string };
}

export function ErrorPanel({ error }: Props) {
  const isRateLimit = error.type === 'rate-limit';

  return (
    <div class={`error-panel ${isRateLimit ? 'error-panel--rate-limit' : ''}`}>
      {isRateLimit && (
        <div class="error-panel__rate-limit-banner">
          Rate Limit Reached — Pipeline paused until quota resets
        </div>
      )}
      <div class="error-panel__header">
        <span class="error-panel__type">{error.type}</span>
        <span class="error-panel__stage">Stage: {error.stage}</span>
      </div>
      <pre class="error-panel__message">{error.message}</pre>
      <span class="error-panel__time">{new Date(error.timestamp).toLocaleString()}</span>
    </div>
  );
}
