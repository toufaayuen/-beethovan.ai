# Troubleshooting: beethovan.ai showing old version

Run these commands **on the machine that serves beethovan.ai** (your Mac-mini).

## 1. Find where PM2 is running from

```bash
pm2 show beethovan
```

Look at **"exec cwd"** or **"script path"** — that's the directory being served.

## 2. Update the code in that directory

If PM2 runs from **Dropbox path** (`/Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai`):
- Dropbox should auto-sync. Check that the folder is synced.
- Verify: `grep -l "upgradeModal" /Users/kwan/Library/CloudStorage/Dropbox/Cursor/beethovan.ai/index.html` — should print the file path.

If PM2 runs from a **git clone** (e.g. `~/beethovan.ai` or similar):
```bash
cd /path/from/step/1
git pull origin main
```

## 3. Restart PM2

```bash
pm2 restart beethovan
```

## 4. Clear browser cache

- **Chrome/Edge**: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows) for hard refresh
- Or open in Incognito/Private window to test

## 5. Verify

Visit https://beethovan.ai — you should see:
- "✨ UNLIMITED" button (not "✨ UNLIMITED $1")
- When clicked: modal with "$1/month" and "$10/year" options
