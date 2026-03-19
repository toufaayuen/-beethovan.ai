#!/usr/bin/env node
/**
 * Chord accuracy evaluation.
 * Run: npm run eval
 * Requires XAI_API_KEY in .env. Optionally set EVAL_MODEL=xai|groq to test different providers.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const XAI_API_KEY = process.env.XAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const EVAL_MODEL = process.env.EVAL_MODEL || 'xai';

const DATA_DIR = path.join(__dirname, 'data');
const EVAL_CORPUS = path.join(DATA_DIR, 'eval-corpus.json');

// Default eval corpus if file doesn't exist
const DEFAULT_CORPUS = [
  { query: 'Let It Be Beatles', expectedChords: ['C', 'G', 'Am', 'F'] },
  { query: 'Wonderwall Oasis', expectedChords: ['Em7', 'G', 'Dsus4', 'A7sus4', 'C', 'D'] },
  { query: 'Hotel California Eagles', expectedChords: ['Bm', 'F#', 'A', 'E', 'G', 'D', 'Em', 'F#'] },
  { query: 'Tears in Heaven Eric Clapton', expectedChords: ['A', 'E', 'F#m', 'D', 'E7'] },
  { query: 'Stand By Me Ben E King', expectedChords: ['C', 'Am', 'F', 'G'] },
];

function loadCorpus() {
  try {
    const data = fs.readFileSync(EVAL_CORPUS, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return DEFAULT_CORPUS;
  }
}

function normalizeChord(c) {
  if (!c || typeof c !== 'string') return '';
  return c.replace(/\s/g, '').replace(/maj7/g, 'M7').toUpperCase();
}

function extractChordsFromSong(song) {
  const chords = new Set();
  if (!song?.progressions) return chords;
  for (const p of song.progressions) {
    if (p.chords) {
      for (const c of p.chords) chords.add(normalizeChord(c));
    }
    if (p.parts) {
      for (const pt of p.parts) if (pt.chord) chords.add(normalizeChord(pt.chord));
    }
  }
  return chords;
}

function chordOverlap(got, expected) {
  const gotSet = new Set([...got].map(normalizeChord));
  const expSet = new Set(expected.map(normalizeChord));
  let match = 0;
  for (const e of expSet) {
    if (gotSet.has(e)) match++;
  }
  return { match, total: expSet.size, recall: expSet.size ? match / expSet.size : 0 };
}

async function callXai(songQuery) {
  const systemPrompt = `You are an expert at guitar chord charts. Return ONLY valid JSON with title, artist, and progressions (each with label, chords array, optionally parts). No markdown.`;
  const prompt = `Chord chart for: "${songQuery}". Return JSON: { "title": "...", "artist": "...", "progressions": [ { "label": "Verse", "chords": ["C","G","Am","F"] } ] }. Only valid JSON.`;

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Xai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) content = jsonMatch[0];
  return JSON.parse(content);
}

async function callGroq(songQuery) {
  const systemPrompt = `You are an expert at guitar chord charts. Return ONLY valid JSON with title, artist, and progressions (each with label, chords array). No markdown.`;
  const prompt = `Chord chart for: "${songQuery}". Return JSON: { "title": "...", "artist": "...", "progressions": [ { "label": "Verse", "chords": ["C","G","Am","F"] } ] }. Only valid JSON.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) content = jsonMatch[0];
  return JSON.parse(content);
}

async function generateForEval(songQuery) {
  if (EVAL_MODEL === 'groq' && GROQ_API_KEY) return callGroq(songQuery);
  if (XAI_API_KEY) return callXai(songQuery);
  throw new Error('Set XAI_API_KEY or (GROQ_API_KEY + EVAL_MODEL=groq) in .env');
}

async function main() {
  const corpus = loadCorpus();
  const items = Array.isArray(corpus) ? corpus : (corpus.items || corpus.corpus || DEFAULT_CORPUS);

  console.log(`\nChord Accuracy Eval (model: ${EVAL_MODEL})\n${'='.repeat(50)}`);

  let totalRecall = 0;
  let passed = 0;

  for (let i = 0; i < items.length; i++) {
    const { query, expectedChords = [] } = items[i];
    process.stdout.write(`[${i + 1}/${items.length}] ${query}... `);
    try {
      const song = await generateForEval(query);
      const got = extractChordsFromSong(song);
      const { recall } = chordOverlap([...got], expectedChords);
      totalRecall += recall;
      if (recall >= 0.5) passed++;
      console.log(`recall ${(recall * 100).toFixed(0)}%`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  const avgRecall = items.length ? totalRecall / items.length : 0;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Average recall: ${(avgRecall * 100).toFixed(1)}%`);
  console.log(`Passed (≥50% recall): ${passed}/${items.length}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
