# webhook-proxy

A lightweight TypeScript/Node.js proxy that receives webhooks from external sources (GitHub, Vercel, Gmail), verifies their authenticity, and forwards them to a local [OpenClaw](https://openclaw.ai) instance — which then delivers notifications to Discord (or any other configured channel).

## Architecture

```
GitHub / Vercel / Gmail
        │  HTTPS POST
        ▼
https://<hostname>.ts.net/webhooks/github
        │  Tailscale Funnel
        │  (--set-path /webhooks strips prefix → forwards as /github)
        ▼
webhook-proxy :3456          ← this service
  • verifies signatures/tokens   (both /webhooks/* and /* paths accepted)
  • filters relevant events
  • routes per source/repo
        │  HTTP (localhost)
        ▼
OpenClaw Gateway :18789
  /hooks/github-pr-<reponame>
        │
        ▼
Discord (correct channel per repo)
```

## Supported sources

| Source | Endpoint | Verification | Forwarded events |
|--------|----------|-------------|-----------------|
| GitHub | `POST /webhooks/github` | HMAC-SHA256 (`X-Hub-Signature-256`) | `pull_request` → `closed` + `merged=true` only |
| Vercel | `POST /webhooks/vercel` | HMAC-SHA1 (`x-vercel-signature`) | All events |
| Gmail (Pub/Sub) | `POST /webhooks/gmail` | Bearer token (`Authorization`) | All messages |

> **GitHub filter:** Only merged pull requests trigger a notification. Pings, pushes, opened PRs, and unmerged closes are acknowledged (`200 OK`, `{status: "ignored"}`) and silently dropped.

## Per-repo Discord routing (GitHub)

Each GitHub repository is automatically routed to its own OpenClaw hook path and Discord channel:

```
<org>/<repo>  →  /hooks/github-pr-<reponame>  →  #<discord-channel>
```

Example:
```
David-Nekolny/ClawdBotPlayground  →  /hooks/github-pr-clawdbotplayground  →  #clawdbot-playground
David-Nekolny/webhook-proxy       →  /hooks/github-pr-webhook-proxy       →  #webhook-proxy
```

To add a new repository, register a GitHub webhook pointing to the proxy URL and add a matching mapping in `openclaw.json`.

## Quick start

### 1. Clone & install

```bash
git clone https://github.com/David-Nekolny/webhook-proxy.git
cd webhook-proxy
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000

GITHUB_WEBHOOK_SECRET=<secret set in GitHub → Repo → Settings → Webhooks>
VERCEL_WEBHOOK_SECRET=<secret set in Vercel → Project → Settings → Webhooks>
GMAIL_PUBSUB_TOKEN=<token used in Pub/Sub push subscription URL>

OPENCLAW_WEBHOOK_URL=http://localhost:18789
OPENCLAW_HOOKS_TOKEN=<value of hooks.token in openclaw.json>
```

### 3. Configure OpenClaw

In `openclaw.json`, enable external hooks and add mappings:

```json5
{
  "hooks": {
    "enabled": true,
    "token": "<OPENCLAW_HOOKS_TOKEN>",
    "path": "/hooks",
    "mappings": [
      {
        "id": "github-pr-myrepo",
        "match": { "path": "github-pr-myrepo" },
        "action": "agent",
        "wakeMode": "now",
        "name": "GitHub PR Merge",
        "deliver": true,
        "channel": "discord",
        "to": "<discord-channel-id>",
        "messageTemplate": "A GitHub PR was just merged. Write a short merge notification: PR #{{pull_request.number}} — {{pull_request.title}}, merged by {{pull_request.merged_by.login}}, branch: {{pull_request.base.ref}}, URL: {{pull_request.html_url}}. Format nicely with emoji."
      }
    ]
  }
}
```

Restart the OpenClaw gateway after config changes:
```bash
systemctl --user restart openclaw-gateway.service
```

### 4. Expose publicly via Tailscale Funnel

Tailscale Funnel is the recommended way to expose the proxy publicly without needing a domain or opening firewall ports.

**Path-based routing (recommended)** — exposes only the `/webhooks/` path publicly while keeping the rest of the node private:

```bash
tailscale funnel --bg --set-path /webhooks http://127.0.0.1:<PORT>
```

Your public webhook URL will be: `https://<hostname>.<tailnet>.ts.net/webhooks/github`

> **Note:** Tailscale Funnel strips the `/webhooks` prefix before forwarding to the local service.
> The proxy handles this by mounting each router on **both** `/webhooks/<source>` and `/<source>` paths — so both direct access and Funnel-forwarded requests work correctly.

**Full-port routing (simpler)** — exposes the entire service:

```bash
tailscale funnel --bg <PORT>
```

Your public webhook URL will be: `https://<hostname>.<tailnet>.ts.net/webhooks/github`

**Check current Funnel status:**

```bash
tailscale funnel status
```

**Remove Funnel config:**

```bash
tailscale funnel reset
```

### 5. Run

**Development (hot-reload):**
```bash
npm run dev
```

**Production (systemd service — recommended):**
```bash
# Create service file
cat > ~/.config/systemd/user/webhook-proxy.service << 'EOF'
[Unit]
Description=Webhook Proxy (GitHub/Vercel/Gmail → OpenClaw)
After=network.target openclaw-gateway.service

[Service]
Type=simple
WorkingDirectory=/path/to/webhook-proxy
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/webhook-proxy/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=webhook-proxy

[Install]
WantedBy=default.target
EOF

npm run build
systemctl --user daemon-reload
systemctl --user enable --now webhook-proxy.service
```

**Docker:**
```bash
cp .env.example .env   # fill in secrets first
docker compose up -d
docker compose logs -f
```

## Register webhooks

### GitHub

1. Repo → **Settings → Webhooks → Add webhook**
2. Payload URL: `https://<your-funnel-url>/webhooks/github`
3. Content type: `application/json`
4. Secret: value of `GITHUB_WEBHOOK_SECRET`
5. Events: **Pull requests**

Repeat for each repository you want to monitor.

### Vercel

1. Project → **Settings → Webhooks → Add**
2. URL: `https://<your-funnel-url>/webhooks/vercel`
3. Events: choose what you need

### Gmail (Google Cloud Pub/Sub)

1. Create a Pub/Sub topic and push subscription in Google Cloud Console
2. Push endpoint: `https://<your-funnel-url>/webhooks/gmail`
3. Set `GMAIL_PUBSUB_TOKEN` and use it in the subscription URL

## API reference

### `GET /health`

```json
{ "status": "ok", "uptime": 42 }
```

### `POST /webhooks/github`

Accepts GitHub webhook payloads. Verifies `X-Hub-Signature-256`. Forwards only merged PRs.

**Responses:**

| Condition | Status | Body |
|-----------|--------|------|
| Merged PR forwarded | `200` | `{status: "ok"}` |
| Event ignored (not merged PR) | `200` | `{status: "ignored", reason: "..."}` |
| Invalid/missing signature | `401` | `{error: "Invalid signature"}` |
| OpenClaw unreachable | `502` | `{error: "Failed to forward webhook", retry: true}` |

### `POST /webhooks/vercel`

Same pattern — verifies `x-vercel-signature`, forwards all events.

### `POST /webhooks/gmail`

Verifies `Authorization: Bearer <token>`, decodes base64 Pub/Sub message, forwards payload.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | GitHub webhook signing secret |
| `VERCEL_WEBHOOK_SECRET` | Yes | — | Vercel webhook signing secret |
| `GMAIL_PUBSUB_TOKEN` | Yes | — | Bearer token for Gmail Pub/Sub push |
| `OPENCLAW_WEBHOOK_URL` | Yes | — | OpenClaw gateway base URL (e.g. `http://localhost:18789`) |
| `OPENCLAW_HOOKS_TOKEN` | Yes | — | OpenClaw hooks token (`hooks.token` in `openclaw.json`) |

## Logs

```bash
# systemd
journalctl --user -u webhook-proxy -f

# Docker
docker compose logs -f
```

## Project structure

```
src/
├── index.ts                  # Express app entry point
├── middleware/
│   ├── logger.ts             # Pino structured logger
│   └── forwarder.ts          # Routes payload to OpenClaw
└── routes/
    ├── github.ts             # GitHub webhook handler + merge filter
    ├── vercel.ts             # Vercel webhook handler
    └── gmail.ts              # Gmail Pub/Sub handler
```
