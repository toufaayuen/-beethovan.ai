# Hosting beethovan.ai on Hostinger VPS with HTTPS

Two ways to get HTTPS working on your VPS.

---

## Option A: Cloudflare Tunnel (easiest — no nginx, no certs)

Cloudflare Tunnel gives you HTTPS automatically. Cloudflare handles SSL at their edge; your app stays on HTTP internally.

### 1. Point your domain to Cloudflare

In your domain registrar (where you bought beethovan.ai), set nameservers to Cloudflare’s. Add the domain in [Cloudflare Dashboard](https://dash.cloudflare.com).

### 2. Install cloudflared on the VPS

SSH into your Hostinger VPS, then:

```bash
# Ubuntu/Debian
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# Or if using a different package manager, check: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

### 3. Log in and create a tunnel

```bash
cloudflared tunnel login
```

Opens a browser — sign in to Cloudflare and authorize. Then:

```bash
cloudflared tunnel create beethovan
```

Note the tunnel ID (e.g. `abc123-def456-...`).

### 4. Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /root/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: beethovan.ai
    service: http://localhost:3001
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` with your actual tunnel ID.

### 5. Route DNS in Cloudflare

Cloudflare Dashboard → beethovan.ai → DNS:

- Add CNAME: `@` → `<YOUR_TUNNEL_ID>.cfargotunnel.com`

### 6. Run the tunnel

```bash
cloudflared tunnel run beethovan
```

Your app is now available at **https://beethovan.ai**. To run in background:

```bash
sudo cloudflared service install
# Edit /etc/default/cloudflared or systemd unit to run your tunnel
# Or use PM2: pm2 start cloudflared --name tunnel -- tunnel run beethovan
```

---

## Option B: nginx + Let's Encrypt (direct to VPS)

Use this if you want traffic to go straight to your VPS (no Cloudflare).

### Prerequisites

- Domain `beethovan.ai` pointing to your VPS IP (A record)
- Ports 80 and 443 open in Hostinger firewall

### 1. Install nginx and Certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Create nginx config

```bash
sudo nano /etc/nginx/sites-available/beethovan
```

Paste (replace `beethovan.ai` if using a different domain):

```nginx
server {
    listen 80;
    server_name beethovan.ai www.beethovan.ai;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/beethovan /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3. Get SSL certificate

```bash
sudo certbot --nginx -d beethovan.ai -d www.beethovan.ai
```

Follow the prompts. Certbot will configure HTTPS and auto-renewal.

### 4. Verify

Visit **https://beethovan.ai** — it should load with a valid certificate.

---

## Summary

| Approach              | Pros                          | Cons                          |
|-----------------------|-------------------------------|-------------------------------|
| **Cloudflare Tunnel** | No nginx, no certs, free HTTPS| Traffic goes through Cloudflare |
| **nginx + Let's Encrypt** | Direct to VPS, full control | Need nginx + cert setup       |

For most cases, **Option A (Cloudflare Tunnel)** is simpler and works well with your existing setup.
