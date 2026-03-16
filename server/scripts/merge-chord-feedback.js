#!/usr/bin/env node
/**
 * Merge verified chord feedback into chord-reference.json.
 * Use when users report corrections - review feedback, then run this to add to ground truth.
 *
 * Usage: node scripts/merge-chord-feedback.js [--dry-run]
 * With --dry-run: show what would be merged without writing.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const CHORD_REF_FILE = path.join(DATA_DIR, 'chord-reference.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'chord-feedback.json');

const dryRun = process.argv.includes('--dry-run');

function loadJson(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const refs = loadJson(CHORD_REF_FILE);
  const feedback = loadJson(FEEDBACK_FILE);
  if (feedback.length === 0) {
    console.log('No chord feedback to merge.');
    return;
  }

  const existing = new Set(refs.map(r => `${(r.title || '').toLowerCase()}|${(r.artist || '').toLowerCase()}`));
  let merged = 0;

  for (const fb of feedback) {
    const key = `${(fb.title || '').toLowerCase()}|${(fb.artist || '').toLowerCase()}`;
    if (existing.has(key)) continue;

    // Only merge if user provided corrected text (verified correction)
    if (!fb.correctedText || fb.correctedText.trim().length < 5) continue;

    // Parse corrected text: "Intro: C G Am F | Verse: C G Am F | Chorus: F G C Am"
    const sections = fb.correctedText.split('|').map(s => s.trim());
    const progressions = [];
    for (const sec of sections) {
      const colon = sec.indexOf(':');
      const label = colon >= 0 ? sec.slice(0, colon).trim() : 'Main';
      const chordsStr = colon >= 0 ? sec.slice(colon + 1) : sec;
      const chords = chordsStr.split(/[\s,]+/).filter(c => {
        const t = c.trim();
        return t && /^[A-Ga-g][#b]?([mM]|maj|min|dim|aug|sus|add|\d)*(\/[A-Ga-g][#b]?)?$/.test(t);
      });
      if (chords.length > 0) {
        progressions.push({ label: label || 'Section', chords });
      }
    }
    if (progressions.length === 0) continue;

    const newRef = {
      title: fb.title,
      artist: fb.artist || '',
      progressions,
      _source: 'chord-feedback',
      _mergedAt: new Date().toISOString()
    };
    refs.push(newRef);
    existing.add(key);
    merged++;
    console.log(`  + ${fb.title} by ${fb.artist}`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would merge ${merged} songs. Run without --dry-run to apply.`);
    return;
  }
  if (merged > 0) {
    saveJson(CHORD_REF_FILE, refs);
    console.log(`\nMerged ${merged} songs into chord-reference.json`);
  } else {
    console.log('No new songs to merge (all feedback already in reference or missing correctedText).');
  }
}

main();
