import { Router, Request, Response } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { forward } from '../middleware/forwarder';
import logger from '../middleware/logger';

const router = Router();

// Capture raw body for HMAC verification before any JSON parsing
router.use(express.raw({ type: '*/*', limit: '10mb' }));

router.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = (req.headers['x-github-event'] as string) || 'unknown';
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    logger.error('GITHUB_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!signature) {
    logger.warn({ source: 'github', event }, 'Missing X-Hub-Signature-256 header');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest('hex')}`;

  let valid = false;
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    valid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn({ source: 'github', event }, 'Invalid GitHub webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    payload = rawBody.toString('utf-8');
  }

  // Only forward merged pull_request events — skip pings, pushes, and unmerged closes
  if (event !== 'pull_request') {
    logger.debug({ source: 'github', event }, 'Skipping non-pull_request event');
    return res.status(200).json({ status: 'ignored', reason: 'not a pull_request event' });
  }

  const pr = (payload as Record<string, unknown>);
  const action = pr['action'];
  const merged = (pr['pull_request'] as Record<string, unknown> | undefined)?.['merged'];

  if (action !== 'closed' || merged !== true) {
    logger.debug({ source: 'github', event, action, merged }, 'Skipping unmerged/non-closed PR event');
    return res.status(200).json({ status: 'ignored', reason: 'PR not merged' });
  }

  try {
    await forward({
      source: 'github',
      event,
      payload,
      receivedAt: new Date().toISOString(),
    });
    logger.info({ source: 'github', event, action }, 'Webhook forwarded successfully');
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error({ source: 'github', event, err }, 'Failed to forward webhook');
    return res.status(502).json({ error: 'Failed to forward webhook', retry: true });
  }
});

export default router;
