#!/usr/bin/env python3
"""
Build chord index from Chordonomicon (Hugging Face).
Run: pip install datasets && python build_chordonomicon.py

Creates chordonomicon-index.json for Spotify ID lookups.
"""
import json
import os

def convert_harte_to_standard(chord):
    """Convert Harte notation to standard (C, Dm, etc.). Simplified."""
    if not chord or chord == "N" or chord == "X":
        return None
    s = str(chord).strip()
    # Harte: C:min, C:maj7, etc. -> Cm, Cmaj7
    s = s.replace(":min", "m").replace(":maj", "").replace(":min7", "m7")
    s = s.replace(":dim", "dim").replace(":aug", "aug")
    return s if s else None

def main():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install: pip install datasets")
        return 1

    print("Loading Chordonomicon (first run downloads ~90MB)...")
    ds = load_dataset("ailsntua/Chordonomicon", split="train", trust_remote_code=True)

    index = []
    seen = set()
    max_songs = 50000

    # Inspect first row for schema
    first = next(iter(ds))
    cols = first.keys()
    print(f"Columns: {list(cols)}")

    for i, row in enumerate(ds):
        if len(index) >= max_songs:
            break

        spotify_id = row.get("spotify_id") or row.get("spotify_track_id") or row.get("track_id") or ""
        title = row.get("title") or row.get("track_name") or row.get("name") or ""
        artist = row.get("artist") or row.get("artist_name") or row.get("artists") or ""
        if isinstance(artist, list):
            artist = ", ".join(str(a) for a in artist) if artist else ""

        chords_raw = row.get("chords") or row.get("chord_progression") or row.get("progressions") or row.get("chord_progression_full")
        if not title or chords_raw is None:
            continue

        key = (str(title).lower()[:50], str(artist).lower()[:50])
        if key in seen:
            continue
        seen.add(key)

        # Parse chord structure - Chordonomicon uses various formats
        progressions = []
        if isinstance(chords_raw, dict):
            for label, chs in chords_raw.items():
                if isinstance(chs, list):
                    conv = [convert_harte_to_standard(c) for c in chs if convert_harte_to_standard(c)]
                    if conv:
                        progressions.append({"label": label, "chords": conv})
                elif isinstance(chs, str):
                    conv = [c for c in chs.split() if convert_harte_to_standard(c)]
                    if conv:
                        progressions.append({"label": label, "chords": conv})
        elif isinstance(chords_raw, list):
            if chords_raw and isinstance(chords_raw[0], dict):
                for p in chords_raw:
                    chs = p.get("chords", [])
                    conv = [convert_harte_to_standard(c) for c in (chs if isinstance(chs, list) else str(chs).split()) if convert_harte_to_standard(c)]
                    if conv:
                        progressions.append({"label": p.get("label", "Section"), "chords": conv})
            else:
                conv = [convert_harte_to_standard(c) for c in chords_raw if convert_harte_to_standard(c)]
                if conv:
                    progressions.append({"label": "Main", "chords": conv})
        elif isinstance(chords_raw, str):
            conv = [c for c in chords_raw.replace("|", " ").split() if convert_harte_to_standard(c)]
            if conv:
                progressions.append({"label": "Main", "chords": conv})

        if not progressions:
            continue

        entry = {"title": str(title), "artist": str(artist), "progressions": progressions}
        if spotify_id and str(spotify_id).strip():
            entry["spotifyId"] = str(spotify_id).strip()
        index.append(entry)

        if (i + 1) % 10000 == 0:
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
