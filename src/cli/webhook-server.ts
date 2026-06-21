import { startWebhookServer } from '../webhook-server/index.ts';

export async function webhookServer(args: string[]): Promise<void> {
  let port = parseInt(process.env['WEBHOOK_PORT'] ?? '3002', 10);
  const webhookSecret = process.env['AZURE_DEVOPS_WEBHOOK_SECRET'];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[++i]!, 10);
    }
  }

  await startWebhookServer({ port, webhookSecret });
}
