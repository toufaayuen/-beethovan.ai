#!/usr/bin/env node
/**
 * Merge user feedback into chord-reference.json.
 * Run: npm run merge-feedback
 * Reads server/data/feedback.json and merges corrections into chord-reference.json.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const REFERENCE_FILE = path.join(DATA_DIR, 'chord-reference.json');

function loadJson(file, defaultVal) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return defaultVal;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const feedback = loadJson(FEEDBACK_FILE, []);
  if (!Array.isArray(feedback) || feedback.length === 0) {
    console.log('No feedback to merge. Add entries to server/data/feedback.json');
    return;
  }

  const reference = loadJson(REFERENCE_FILE, { entries: [] });
  reference.entries = reference.entries || [];

  const key = (title, artist) => `${(title || '').toLowerCase().trim()}::${(artist || '').toLowerCase().trim()}`;
  const refMap = new Map();
  for (const e of reference.entries) {
    refMap.set(key(e.title, e.artist), e);
  }

  let merged = 0;
  for (const f of feedback) {
    if (!f.title || !f.correctedProgressions || !Array.isArray(f.correctedProgressions)) continue;
    const k = key(f.title, f.artist);
    const existing = refMap.get(k);
    if (existing) {
      existing.progressions = f.correctedProgressions;
      existing.updatedAt = new Date().toISOString();
      existing.source = 'feedback';
    } else {
      reference.entries.push({
        title: f.title,
        artist: f.artist || 'Unknown',
        progressions: f.correctedProgressions,
        addedAt: new Date().toISOString(),
        source: 'feedback',
      });
      refMap.set(k, reference.entries[reference.entries.length - 1]);
    }
    merged++;
  }

  saveJson(REFERENCE_FILE, reference);
  console.log(`Merged ${merged} feedback entries into chord-reference.json`);
}

main();
