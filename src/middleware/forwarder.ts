import logger from './logger';

export type WebhookSource = 'github' | 'vercel' | 'gmail';

export interface ForwardPayload {
  source: WebhookSource;
  event: string;
  payload: unknown;
  receivedAt: string;
}

const FORWARD_TIMEOUT_MS = 10_000;

export async function forward(data: ForwardPayload): Promise<void> {
  const url = process.env.OPENCLAW_WEBHOOK_URL;
  const secret = process.env.PROXY_SECRET ?? '';

  if (!url) {
    throw new Error('OPENCLAW_WEBHOOK_URL is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': secret,
        'X-Source': data.source,
        'X-Event': data.event,
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error forwarding webhook: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Upstream returned ${response.status} ${response.statusText}: ${body}`.trimEnd(),
    );
  }

  logger.debug({ source: data.source, event: data.event, url }, 'Forwarded to OpenClaw');
}
