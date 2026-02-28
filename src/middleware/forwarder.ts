import logger from './logger';

export type WebhookSource = 'github' | 'vercel' | 'gmail';

export interface ForwardPayload {
  source: WebhookSource;
  event: string;
  payload: unknown;
  receivedAt: string;
}

const FORWARD_TIMEOUT_MS = 10_000;

function buildMessage(data: ForwardPayload): string {
  const summary = JSON.stringify(data.payload).slice(0, 400);
  return `Webhook received from ${data.source} [${data.event}] at ${data.receivedAt}:\n${summary}`;
}

function sourceName(source: WebhookSource): string {
  return { github: 'GitHub', vercel: 'Vercel', gmail: 'Gmail' }[source];
}

export async function forward(data: ForwardPayload): Promise<void> {
  const baseUrl = process.env.OPENCLAW_WEBHOOK_URL;
  const token = process.env.OPENCLAW_HOOKS_TOKEN ?? '';

  if (!baseUrl) {
    throw new Error('OPENCLAW_WEBHOOK_URL is not configured');
  }

  // Strip trailing slash and append /hooks/agent
  const url = baseUrl.replace(/\/+$/, '') + '/hooks/agent';

  const body = {
    name: sourceName(data.source),
    message: buildMessage(data),
    wakeMode: 'now',
    deliver: true,
    channel: 'discord',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Source': data.source,
        'X-Event': data.event,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error forwarding webhook: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `Upstream returned ${response.status} ${response.statusText}: ${bodyText}`.trimEnd(),
    );
  }

  logger.info({ source: data.source, event: data.event, url }, 'Forwarded to OpenClaw');
}
