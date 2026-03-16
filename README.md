# BEETHOVAN.AI

Chord charts for any song — free AI search, save up to 10 songs (free account), or **$1/month or $10/year** for unlimited saved songs.

## Features

- **Free AI search**: No API key needed — search any song and get chord charts (server uses a shared DeepSeek key).
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
   - `DEEPSEEK_API_KEY` — your DeepSeek API key (for free AI search).
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

## Stripe (subscription: $1/mo or $10/yr)

1. Create a [Stripe](https://stripe.com) account and get your **Secret key**.
2. In Dashboard → Products → Add two products:
   - **Monthly**: "Unlimited Saves Monthly", recurring **$1/month**. Copy the Price ID (`price_...`).
   - **Yearly**: "Unlimited Saves Yearly", recurring **$10/year**. Copy the Price ID.
3. Set in `.env`: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_YEARLY`.
4. For automatic upgrade: add a Webhook endpoint `https://your-domain.com/api/webhook/stripe`, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET` in `.env`.

## Chord accuracy evaluation

To measure chord correct rate before/after prompt or model changes:

1. Start the server: `cd server && npm start`
2. Run: `npm run eval` (or `node eval-chord-accuracy.js --api=http://localhost:3001`)
3. Report is saved to `server/data/chord-accuracy-report.json`

Ground truth is in `server/data/chord-reference.json`. Add more songs there to expand the benchmark. For multilingual songs (Cantonese, Korean, etc.), include an `aliases` array with romanized or alternate titles to improve search matching.

## Improving chord accuracy (training)

Chord lookup priority: **Chordonomicon** (by Spotify ID) → **chord-reference** (RAG) → **AI** (Xai).

### 1. Chordonomicon (666K songs, Spotify-linked)

Build an index from the [Chordonomicon](https://huggingface.co/datasets/ailsntua/Chordonomicon) dataset for high-accuracy lookups when Spotify is configured:

```bash
cd server
pip install datasets
npm run build-chordonomicon
```

Creates `server/data/chordonomicon-index.json`. With Spotify credentials, searches will use Chordonomicon first when a track is found.

### 2. chord-reference.json (RAG)

Add verified chord progressions to `server/data/chord-reference.json`. Include `aliases` for alternate titles (romanized, other languages). These are used as RAG context and for direct matches.

### 3. Chord feedback → training data

When users click "Report error" and provide corrected chords, feedback is stored in `chord-feedback.json`. Merge verified corrections into chord-reference:

```bash
cd server
npm run merge-feedback          # Merge all feedback with correctedText
npm run merge-feedback -- --dry-run   # Preview without writing
```

### 4. Spotify API (optional)

Configure Spotify in the app to improve song disambiguation and enable Chordonomicon lookups. Get credentials at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

### 5. ChordMini (audio analysis)

[ChordMini](https://www.chordmini.me/docs) can analyze audio for chord recognition. To integrate: proxy Spotify preview URLs through your server to ChordMini's `/api/recognize-chords` (rate limit: 2/min). Not included by default.

## Data

- Users and saved songs are stored in `server/data/store.json` (create the folder if needed). Use a real database in production.
- Chord feedback (from "Report error" button) is stored in `server/data/chord-feedback.json`.
