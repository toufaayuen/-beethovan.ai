# BEETHOVAN.AI

Chord charts for any song — free AI search, save up to 10 songs (free account), or **$1/month or $10/year** for unlimited saved songs.

## Features

- **AI chord charts**: Search any song and get chord charts (powered by Xai API).
- **Multi-Genre Real Book** (`/realbook`): 50+ curated tunes across jazz, pop, rock, hip-hop, classical, K-pop, and more — AI “fake book” lead sheets, cross-genre remix, PDF export (jsPDF via CDN), community suggestions (`server/data/realbook-suggestions.json`), and “add to book” extensions (`server/data/realbook-extensions.json`). APIs live in `server/api/chords.js` (`/api/chords/realbook-*`).
- **Register**: Create an account to save songs (free: max 10).
- **Unlimited membership**: Subscribe for $1/month or $10/year to save unlimited songs (Stripe).

## Quick start

1. **Go to the project folder** (where `server/` and `index.html` live)
   ```bash
   cd /path/to/beethovan.ai
   ```
   Or in Terminal: `cd` and drag the `beethovan.ai` folder in.

2. **Install server dependencies**
   ```bash
   cd server && npm install
   ```

3. **Configure environment**
   ```bash
   cp server/.env.example server/.env
   ```
   Edit `server/.env`:
   - `XAI_API_KEY` — your Xai API key (for chord chart generation).
   - `JWT_SECRET` — use a long random string in production.
   - Optional (for subscription): `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY`, `STRIPE_WEBHOOK_SECRET`.

4. **Run the server**
   ```bash
   cd server && npm start
   ```
   Open **http://localhost:3001** — the app is served from the same origin (no CORS issues).

5. **Development (frontend only)**
   If you open `index.html` from the file system or another port, set the API base in `index.html` before loading `script.js`:
   ```html
   <script>window.API_BASE = 'http://localhost:3001';</script>
   <script src="script.js"></script>
   ```

## Server mode (beethovan.ai)

By default the server binds to `0.0.0.0` so it can accept connections for **beethovan.ai**. CORS allows `https://beethovan.ai`, `https://www.beethovan.ai`, and localhost for dev. Put the app behind nginx or a Cloudflare tunnel for HTTPS. For localhost-only, set `HOST=127.0.0.1` in `server/.env`.

## Stripe (subscription: $1/mo or $10/yr)

1. Create a [Stripe](https://stripe.com) account and get your **Secret key**.
2. In Dashboard → Products → Add two products:
   - **Monthly**: "Unlimited Saves Monthly", recurring **$1/month**. Copy the Price ID (`price_...`).
   - **Yearly**: "Unlimited Saves Yearly", recurring **$10/year**. Copy the Price ID.
3. Set in `.env`: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY`.
4. For automatic upgrade: add a Webhook endpoint `https://your-domain.com/api/webhook/stripe`, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET` in `.env`.

## Spotify (optional)

Configure Spotify in the app to improve song disambiguation and chord accuracy. When configured, the app fetches track metadata (BPM, key) from Spotify and passes it to the AI for better chord suggestions. Get credentials at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

## Data

- Users and saved songs are stored in SQLite (`server/data/beethovan.db`). On first run, existing `store.json` is migrated automatically.
