import { Router, Request, Response } from 'express';
import express from 'express';
import { forward } from '../middleware/forwarder';
import logger from '../middleware/logger';

const router = Router();

// Parse JSON — Gmail Pub/Sub push messages are always JSON
router.use(express.json({ limit: '10mb' }));

interface PubSubMessage {
  data?: string;
  messageId?: string;
  publishTime?: string;
  attributes?: Record<string, string>;
}

interface PubSubPushBody {
  message?: PubSubMessage;
  subscription?: string;
}

router.post('/', async (req: Request, res: Response) => {
  const authHeader = req.headers['authorization'] as string | undefined;
  const expectedToken = process.env.GMAIL_PUBSUB_TOKEN;

  if (!expectedToken) {
    logger.error('GMAIL_PUBSUB_TOKEN is not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // Verify Bearer token using constant-time comparison
  const bearerPrefix = 'Bearer ';
  if (!authHeader || !authHeader.startsWith(bearerPrefix)) {
    logger.warn({ source: 'gmail' }, 'Missing or malformed Authorization header');
    return res.status(401).json({ error: 'Missing or invalid authorization' });
  }

  const token = authHeader.slice(bearerPrefix.length);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expectedToken);
  const valid =
    tokenBuf.length === expectedBuf.length &&
    (() => {
      try {
        const { timingSafeEqual } = require('crypto') as typeof import('crypto');
        return timingSafeEqual(tokenBuf, expectedBuf);
      } catch {
        return false;
      }
    })();

  if (!valid) {
    logger.warn({ source: 'gmail' }, 'Invalid Gmail Pub/Sub authorization token');
    return res.status(401).json({ error: 'Invalid authorization token' });
  }

  const body = req.body as PubSubPushBody;
  const message = body?.message;

  if (!message) {
    logger.warn({ source: 'gmail' }, 'Pub/Sub push body missing message field');
    return res.status(400).json({ error: 'Invalid Pub/Sub message format' });
  }

  // Decode base64-encoded message data
  let decodedData: unknown = null;
  if (message.data) {
    try {
      const raw = Buffer.from(message.data, 'base64').toString('utf-8');
      try {
        decodedData = JSON.parse(raw);
      } catch {
        decodedData = raw;
      }
    } catch {
      logger.warn({ source: 'gmail' }, 'Failed to decode Pub/Sub message data');
      return res.status(400).json({ error: 'Invalid base64 message data' });
    }
  }

  const payload = {
    decodedData,
    messageId: message.messageId,
    publishTime: message.publishTime,
    attributes: message.attributes,
    subscription: body.subscription,
  };

  const event = message.attributes?.['eventType'] ?? 'gmail.message';

  try {
    await forward({
      source: 'gmail',
      event,
      payload,
      receivedAt: new Date().toISOString(),
    });
    logger.info({ source: 'gmail', event }, 'Webhook forwarded successfully');
    // Pub/Sub requires a 2xx to acknowledge delivery
    return res.status(204).send();
  } catch (err) {
    logger.error({ source: 'gmail', event, err }, 'Failed to forward webhook');
    // Non-2xx causes Pub/Sub to retry
    return res.status(502).json({ error: 'Failed to forward webhook', retry: true });
  }
});

export default router;
