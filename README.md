# webhook-proxy

A lightweight TypeScript/Node.js Express server that receives webhooks from external sources, verifies their authenticity, and forwards them to an OpenClaw instance.

## Supported sources

| Source | Endpoint | Verification |
|--------|----------|-------------|
| GitHub | `POST /webhooks/github` | HMAC-SHA256 (`X-Hub-Signature-256`) |
| Vercel | `POST /webhooks/vercel` | HMAC-SHA1 (`x-vercel-signature`) |
| Gmail (Pub/Sub) | `POST /webhooks/gmail` | Bearer token (`Authorization`) |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your secrets

# 3. Run in development mode (with hot-reload)
npm run dev

# 4. Build for production
npm run build
npm start
```

## Docker

```bash
# Build and start with docker-compose
cp .env.example .env   # fill in secrets first
docker compose up -d

# View logs
docker compose logs -f
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default: `3000`) |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `GITHUB_WEBHOOK_SECRET` | Yes | GitHub webhook signing secret |
| `VERCEL_WEBHOOK_SECRET` | Yes | Vercel webhook signing secret |
| `GMAIL_PUBSUB_TOKEN` | Yes | Bearer token for Gmail Pub/Sub push |
| `OPENCLAW_WEBHOOK_URL` | Yes | OpenClaw gateway base URL (e.g. `http://localhost:18789`) |
| `OPENCLAW_HOOKS_TOKEN` | Yes | OpenClaw hooks token (`hooks.token` in `openclaw.json`) |

## Forwarded request format

Every verified webhook is forwarded as a `POST` to `$OPENCLAW_WEBHOOK_URL/hooks/agent` using the [OpenClaw Hooks API](https://docs.openclaw.ai):

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <OPENCLAW_HOOKS_TOKEN>
X-Source: github | vercel | gmail
X-Event: <event type>
```

**Body:**
```json
{
  "name": "GitHub",
  "message": "Webhook received from github [push] at 2024-01-01T00:00:00.000Z:\n{...payload summary...}",
  "wakeMode": "now",
  "deliver": true,
  "channel": "discord"
}
```

## Health check

```
GET /health
→ 200 { "status": "ok", "uptime": 42 }
```

## Error responses

| Condition | Status |
|-----------|--------|
| Missing / invalid signature | `401 Unauthorized` |
| Forwarding to OpenClaw failed | `502 Bad Gateway` |
| Unknown route | `404 Not Found` |

## Project structure

```
src/
├── index.ts                  # Express app setup and entry point
├── middleware/
│   ├── logger.ts             # Pino structured logger
│   └── forwarder.ts          # Forwards payload to OpenClaw
└── routes/
    ├── github.ts             # GitHub webhook handler
    ├── vercel.ts             # Vercel webhook handler
    └── gmail.ts              # Gmail Pub/Sub handler
```
