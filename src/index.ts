import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import logger from './middleware/logger';
import githubRouter from './routes/github';
import vercelRouter from './routes/vercel';
import gmailRouter from './routes/gmail';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const startedAt = Date.now();

// Disable x-powered-by header
app.disable('x-powered-by');

// Mount webhook routers — each router applies its own body parser
app.use('/webhooks/github', githubRouter);
app.use('/webhooks/vercel', vercelRouter);
app.use('/webhooks/gmail', gmailRouter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

// 404 for all unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Webhook proxy server started');
});

export default app;
