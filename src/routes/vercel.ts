import { Router, Request, Response } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { forward } from '../middleware/forwarder';
import logger from '../middleware/logger';

const router = Router();

// Capture raw body for HMAC-SHA1 verification
router.use(express.raw({ type: '*/*', limit: '10mb' }));

router.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const signature = req.headers['x-vercel-signature'] as string | undefined;
  const secret = process.env.VERCEL_WEBHOOK_SECRET;

  if (!secret) {
    logger.error('VERCEL_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!signature) {
    logger.warn({ source: 'vercel' }, 'Missing x-vercel-signature header');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const hmac = createHmac('sha1', secret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');

  let valid = false;
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    valid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn({ source: 'vercel' }, 'Invalid Vercel webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    payload = rawBody.toString('utf-8');
  }

  // Attempt to extract an event type from the parsed payload
  const event =
    (req.headers['x-vercel-event'] as string) ||
    (typeof payload === 'object' && payload !== null && 'type' in payload
      ? String((payload as Record<string, unknown>).type)
      : 'unknown');

  try {
    await forward({
      source: 'vercel',
      event,
      payload,
      receivedAt: new Date().toISOString(),
    });
    logger.info({ source: 'vercel', event }, 'Webhook forwarded successfully');
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error({ source: 'vercel', event, err }, 'Failed to forward webhook');
    return res.status(502).json({ error: 'Failed to forward webhook', retry: true });
  }
});

export default router;
