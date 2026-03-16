#!/usr/bin/env node
/**
 * Build chord index from Chordonomicon dataset (Hugging Face).
 * Run once: npm run build-chordonomicon
 *
 * Requires: pip install datasets
 * Then: node scripts/build-chordonomicon-index.js
 *
 * Or use the Python version: python scripts/build_chordonomicon.py
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '../data');
const OUTPUT_FILE = path.join(DATA_DIR, 'chordonomicon-index.json');
const PYTHON_SCRIPT = path.join(__dirname, 'build_chordonomicon.py');

// Check if Python script exists; if not, provide instructions
const pyPath = path.join(__dirname, 'build_chordonomicon.py');
if (!fs.existsSync(pyPath)) {
  console.log('Creating Python build script...');
  const pyScript = `#!/usr/bin/env python3
"""Build chord index from Chordonomicon (Hugging Face). Run: pip install datasets && python build_chordonomicon.py"""
import json
import os

def main():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return 1

    print("Loading Chordonomicon (this may take a few minutes)...")
    ds = load_dataset("ailsntua/Chordonomicon", split="train", trust_remote_code=True)
    
    index = []
    seen = set()
    max_songs = 50000  # Limit for manageable file size
    
    for i, row in enumerate(ds):
        if len(index) >= max_songs:
            break
        # Schema varies - try common column names
        spotify_id = row.get("spotify_id") or row.get("spotify_track_id") or row.get("track_id") or ""
        title = row.get("title") or row.get("track_name") or row.get("name") or ""
        artist = row.get("artist") or row.get("artist_name") or row.get("artists") or ""
        if isinstance(artist, list):
            artist = ", ".join(artist) if artist else ""
        
        # Get chord progressions - structure varies
        chords = row.get("chords") or row.get("chord_progression") or row.get("progressions") or []
        if not chords and "sections" in row:
            sections = row.get("sections", [])
            chords = [{"label": s.get("label", "Section"), "chords": s.get("chords", [])} for s in sections]
        
        if not title or not chords:
            continue
            
        key = (str(title).lower(), str(artist).lower())
        if key in seen:
            continue
        seen.add(key)
        
        # Normalize to our format
        if isinstance(chords, str):
            progressions = [{"label": "Main", "chords": [c.strip() for c in chords.split() if c.strip()]}]
        elif isinstance(chords, list):
            if chords and isinstance(chords[0], dict):
                progressions = [{"label": p.get("label", "Section"), "chords": p.get("chords", [])} for p in chords]
            else:
                progressions = [{"label": "Main", "chords": [str(c) for c in chords]}]
        else:
            continue
            
        index.append({
            "title": str(title),
            "artist": str(artist),
            "spotifyId": str(spotify_id) if spotify_id else undefined,
            "progressions": progressions
        })
        
        if (i + 1) % 5000 == 0:
            print(f"  Processed {i+1} rows, {len(index)} unique songs...")
    
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "chordonomicon-index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=0)
    print(f"Saved {len(index)} songs to {out_path}")
    return 0

if __name__ == "__main__":
    exit(main())
`;
  fs.writeFileSync(pyPath, pyScript, 'utf8');
  console.log('Created build_chordonomicon.py');
}

console.log(`
Chordonomicon Index Builder
==========================

To build the index from Chordonomicon (666K songs):

1. Install Python dependency:
   pip install datasets

2. Run the Python script:
   cd server/scripts && python build_chordonomicon.py

3. This creates server/data/chordonomicon-index.json
   The server will automatically use it for Spotify ID lookups.

Note: First run downloads ~90MB. Limit is 50k songs for performance.
`);
