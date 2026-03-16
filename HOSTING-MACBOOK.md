# Hosting beethovan.ai on Your MacBook Pro

This guide walks you through running beethovan.ai as a self-hosted server on your 2018 MacBook Pro and exposing it to the internet.

## Prerequisites

- Node.js (v18+ recommended) — install via [nodejs.org](https://nodejs.org) or `brew install node`
- Your MacBook on the same network as your router (for internet access)

---

## 1. One-time setup

```bash
cd /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai
cd server && npm install
```

Copy and edit your environment:

```bash
cp server/.env.example server/.env
```

Edit `server/.env` and set at minimum:

- `JWT_SECRET` — use a long random string (e.g. `openssl rand -hex 32`)
- `DEEPSEEK_API_KEY` or `XAI_API_KEY` — for AI chord search
- `PORT=3001` (or another port if 3001 is in use)

---

## 2. Run the server (manual test)

```bash
cd /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai/server
npm start
```

Open **http://localhost:3001** — the app should load. Stop with `Ctrl+C` when done testing.

---

## 3. Keep it running in the background (PM2)

Install [PM2](https://pm2.keymetrics.io/) to keep the server running even when you close Terminal:

```bash
npm install -g pm2
```

Start beethovan.ai with PM2:

```bash
cd /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai/server
pm2 start index.js --name beethovan
```

Useful PM2 commands:

| Command | Description |
|---------|-------------|
| `pm2 list` | See running processes |
| `pm2 logs beethovan` | View logs |
| `pm2 restart beethovan` | Restart after code changes |
| `pm2 stop beethovan` | Stop the server |
| `pm2 delete beethovan` | Remove from PM2 |

Make PM2 start on Mac boot (optional):

```bash
pm2 startup
pm2 save
```

---

## 4. Expose to the internet (Cloudflare Tunnel)

Your MacBook has a private IP. To reach it from the internet, use **Cloudflare Tunnel** (free, no router changes needed).

### 4a. Install cloudflared

```bash
brew install cloudflared
```

### 4b. Log in to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser — sign in to Cloudflare and authorize the app. It saves credentials to `~/.cloudflared/`.

### 4c. Create a tunnel

```bash
cloudflared tunnel create beethovan
```

Note the tunnel ID (e.g. `abc123-def456-...`).

### 4d. Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/kwan/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: beethovan.ai
    service: http://localhost:3001
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` with the ID from step 4c.

### 4e. Route your domain

In [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain → **DNS**:

1. Add a CNAME record: `@` (or `beethovan`) → `<YOUR_TUNNEL_ID>.cfargotunnel.com`
2. If using a subdomain like `app.beethovan.ai`, use that as the hostname in both DNS and `config.yml`

### 4f. Run the tunnel

```bash
cloudflared tunnel run beethovan
```

Leave this running. Your app is now reachable at **https://beethovan.ai** (or your chosen hostname).

### 4g. Run tunnel in background (optional)

```bash
cloudflared service install
```

Then edit the service config to use your tunnel, or run `cloudflared tunnel run beethovan` via PM2:

```bash
pm2 start cloudflared --name tunnel -- tunnel run beethovan
pm2 save
```

---

## 5. Stripe webhooks (if using subscription)

If you use Stripe for the unlimited membership ($1/mo or $10/yr):

1. In Stripe Dashboard → Webhooks → Add endpoint
2. URL: `https://beethovan.ai/api/webhook/stripe`
3. Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
4. Copy the webhook signing secret and add to `.env` as `STRIPE_WEBHOOK_SECRET`

---

## 6. Production checklist

- [ ] `JWT_SECRET` is a long random string (not the default)
- [ ] `DEEPSEEK_API_KEY` or `XAI_API_KEY` is set
- [ ] Stripe keys and webhook secret configured (if using payments)
- [ ] `server/data/` exists and is writable
- [ ] PM2 keeps the server running
- [ ] Cloudflare Tunnel is running for public access

---

## 7. Quick reference: start everything

After initial setup, to bring everything up:

```bash
cd /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai/server
pm2 start index.js --name beethovan
# In another terminal (or via PM2):
cloudflared tunnel run beethovan
```

---

## Notes

- **Uptime**: The app is only available when your MacBook is on and these processes are running.
- **Power**: Consider keeping the Mac plugged in if running 24/7.
- **Data**: User data is in `server/data/store.json`. Back this up regularly.
- **Updates**: After pulling code changes, run `pm2 restart beethovan`.
