# Development Guide

## Quick start (local dev)

**On Mac-mini** (where PM2 runs production):

1. Stop production so port 3001 is free:
   ```bash
   pm2 stop beethovan
   ```

2. Start dev server (auto-restarts on backend changes):
   ```bash
   cd /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai
   npm run dev
   ```
   Or: `cd server && npm run dev`

3. Open **http://localhost:3001** in your browser.

4. Edit files:
   - `index.html`, `script.js`, `style.css` → refresh browser
   - `server/index.js` → server auto-restarts

5. When done, restart production:
   ```bash
   pm2 start beethovan
   ```

---

## On a different machine (e.g. laptop)

If you develop on a laptop and deploy via Dropbox sync:

1. `cd beethovan.ai/server && npm install`
2. Copy `server/.env.example` to `server/.env` and add your API keys
3. `npm run dev` (from project root or `server/`)
4. Open http://localhost:3001

No PM2 conflict — production runs only on the Mac-mini.

---

## File structure

| Edit | Files | Effect |
|------|-------|--------|
| Frontend | `index.html`, `script.js`, `style.css` | Refresh browser |
| Backend | `server/index.js` | Auto-restart (with `npm run dev`) |
| Chord data | `server/data/chord-reference.json`, `server/data/feedback.json` | Restart server for feedback |
| Env | `server/.env` | Restart server |

---

## Deploy changes to production

1. Save your changes (Dropbox syncs to Mac-mini)
2. SSH or use the Mac-mini directly:
   ```bash
   pm2 restart beethovan
   ```

---

## Useful commands

```bash
# Chord accuracy evaluation (after prompt/model changes)
# Requires XAI_API_KEY. Set EVAL_MODEL=groq to test Groq instead.
cd server && npm run eval

# Merge user feedback into chord-reference.json
# Reads server/data/feedback.json; entries with correctedProgressions are merged.
cd server && npm run merge-feedback
```
