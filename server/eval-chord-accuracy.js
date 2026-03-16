#!/usr/bin/env node
/**
 * Chord accuracy evaluation script.
 * Compares LLM-generated chord charts to ground truth in chord-reference.json.
 *
 * Usage: node eval-chord-accuracy.js [--api=http://localhost:3001]
 * Requires: Server running with DEEPSEEK_API_KEY, or use --api to point to your server.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.argv.find(a => a.startsWith('--api='))?.split('=')[1] || 'http://localhost:3001';

// Chord equivalence: C# = Db, etc.
const CHORD_ALIASES = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
  'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'
};

function normalizeChord(c) {
  if (!c || typeof c !== 'string') return '';
  const m = c.match(/^([A-G][#b]?)(.*)$/i);
  if (!m) return c.trim();
  const root = m[1];
  const suffix = (m[2] || '').trim();
  const canon = CHORD_ALIASES[root] || root;
  return canon + suffix;
}

function chordsMatch(a, b) {
  return normalizeChord(a) === normalizeChord(b);
}

function progressionAccuracy(expected, predicted) {
  if (!expected?.chords?.length) return 1;
  if (!predicted?.chords?.length) return 0;
  const exp = expected.chords;
  const pred = predicted.chords;
  let correct = 0;
  for (let i = 0; i < Math.min(exp.length, pred.length); i++) {
    if (chordsMatch(exp[i], pred[i])) correct++;
  }
  return correct / exp.length;
}

function findMatchingProgression(label, progressions) {
  if (!progressions?.length) return null;
  const l = (label || '').toLowerCase();
  return progressions.find(p => (p.label || '').toLowerCase().includes(l) || l.includes((p.label || '').toLowerCase()))
    || progressions[0];
}

function songAccuracy(groundTruth, predicted) {
  if (!groundTruth?.progressions?.length) return 1;
  if (!predicted?.progressions?.length) return 0;
  let total = 0;
  let sum = 0;
  for (const exp of groundTruth.progressions) {
    const pred = findMatchingProgression(exp.label, predicted.progressions);
    const acc = progressionAccuracy(exp, pred);
    total += exp.chords?.length || 0;
    sum += (exp.chords?.length || 0) * acc;
  }
  return total > 0 ? sum / total : 0;
}

async function runEval() {
  const refPath = path.join(__dirname, 'data', 'chord-reference.json');
  if (!fs.existsSync(refPath)) {
    console.error('Missing data/chord-reference.json');
    process.exit(1);
  }
  const benchmark = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  console.log(`Evaluating ${benchmark.length} songs against ${API_BASE}/api/generate-chords\n`);

  const results = [];
  let totalAcc = 0;

  for (let i = 0; i < benchmark.length; i++) {
    const ref = benchmark[i];
    const query = `${ref.title} ${ref.artist}`;
    process.stdout.write(`[${i + 1}/${benchmark.length}] ${ref.title}... `);
    try {
      const res = await fetch(API_BASE + '/api/generate-chords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API ${res.status}: ${err.slice(0, 100)}`);
      }
      const predicted = await res.json();
      const acc = songAccuracy(ref, predicted);
      totalAcc += acc;
      results.push({ title: ref.title, artist: ref.artist, accuracy: acc, predicted });
      console.log((acc * 100).toFixed(1) + '%');
    } catch (e) {
      console.log('FAIL: ' + e.message);
      results.push({ title: ref.title, artist: ref.artist, accuracy: 0, error: e.message });
    }
  }

  const avgAcc = results.length > 0 ? totalAcc / results.length : 0;
  const report = {
    timestamp: new Date().toISOString(),
    apiBase: API_BASE,
    totalSongs: benchmark.length,
    chordCorrectRate: avgAcc,
    perSong: results.map(r => ({ title: r.title, artist: r.artist, accuracy: r.accuracy }))
  };

  const reportPath = path.join(__dirname, 'data', 'chord-accuracy-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n--- Summary ---');
  console.log('Chord correct rate:', (avgAcc * 100).toFixed(1) + '%');
  console.log('Report saved to:', reportPath);
}

runEval().catch(e => {
  console.error(e);
  process.exit(1);
});
