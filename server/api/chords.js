/**
 * Real Book / lead-sheet APIs (xAI Grok). Mounted from server/index.js.
 * Routes: /api/chords/realbook-* and GET /api/realbook/catalog
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Base catalog lives in repo (server/realbook-catalog.json); extensions/suggestions in data/
const CATALOG_FILE = path.join(__dirname, '..', 'realbook-catalog.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'realbook-suggestions.json');
const EXTENSIONS_FILE = path.join(DATA_DIR, 'realbook-extensions.json');

function safeReadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseJsonBlock(content) {
  if (!content || typeof content !== 'string') throw new Error('Empty AI response');
  let c = content.trim();
  const jsonMatch = c.match(/```json\s*([\s\S]*?)\s*```/) || c.match(/```\s*([\s\S]*?)\s*```/);
  if (jsonMatch) c = jsonMatch[1].trim();
  const obj = c.match(/\{[\s\S]*\}/);
  if (obj) c = obj[0];
  try {
    return JSON.parse(c);
  } catch (e) {
    const aggressive = content.match(/\{[\s\S]*"leadSheet"[\s\S]*\}/)
      || content.match(/\{[\s\S]*"worthy"[\s\S]*\}/)
      || content.match(/\{[\s\S]*"remixedLeadSheet"[\s\S]*\}/);
    if (aggressive) return JSON.parse(aggressive[0]);
    throw new Error('Invalid JSON in AI response');
  }
}

async function xaiJson({ apiKey, system, user, maxTokens = 6000, temperature = 0.25 }) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`XAI ${response.status}: ${err.slice(0, 400)}`);
  }
  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  return parseJsonBlock(rawContent);
}

function mergeCatalog() {
  const base = safeReadJson(CATALOG_FILE, []);
  const ext = safeReadJson(EXTENSIONS_FILE, []);
  const arrBase = Array.isArray(base) ? base : [];
  const arrExt = Array.isArray(ext) ? ext : [];
  const seen = new Set(arrBase.map((s) => s.id));
  const merged = [...arrBase];
  for (const e of arrExt) {
    if (e && e.id && !seen.has(e.id)) {
      merged.push(e);
      seen.add(e.id);
    }
  }
  return merged;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * @param {import('express').Application} app
 * @param {{ getXaiKey: () => string }} opts
 */
function registerChordsApi(app, opts) {
  const getXaiKey = opts.getXaiKey || (() => '');

  function requireXai(req, res, next) {
    const key = getXaiKey();
    if (!key) {
      return res.status(503).json({ error: 'XAI not configured. Set XAI_API_KEY in server/.env' });
    }
    req._xaiKey = key;
    next();
  }

  app.get('/api/realbook/catalog', (req, res) => {
    try {
      const songs = mergeCatalog();
      const genres = [...new Set(songs.map((s) => s.genre).filter(Boolean))].sort();
      res.json({ songs, genres });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Real Book-style lead sheet: { leadSheet, improvTips }
   */
  app.post('/api/chords/realbook-lead-sheet', requireXai, async (req, res) => {
    const { title, artist, genre } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    const g = (genre && String(genre)) || 'General';
    const a = (artist && String(artist)) || 'Unknown';
    const system = `You are a professional music editor for a modern multi-genre Real Book (fake book). Use your knowledge of the song. Output ONLY valid JSON with no surrounding markdown.`;
    const user = `Create a fake book entry for "${title}" by ${a} in ${g} style.

Include:
- Chord progressions with symbols over representative lyrics (lead-sheet style; abbreviated lyrics)
- Simple melody snippets (letter names or scale degrees, very short)
- Explicit KEY and TEMPO (BPM or descriptive)
- 4–8 improv tips adapted to the genre (e.g. jazz substitutions on a rock tune, pocket/feel for hip-hop, voice-leading for classical)

Return JSON exactly:
{"leadSheet":"string (sections VERSE/CHORUS etc., chords over lyrics, key, tempo, melody hints)","improvTips":["tip1","tip2"]}`;
    try {
      const out = await xaiJson({
        apiKey: req._xaiKey,
        system,
        user,
        maxTokens: 7000,
      });
      if (typeof out.leadSheet !== 'string' || !Array.isArray(out.improvTips)) {
        return res.status(502).json({ error: 'Invalid AI response shape' });
      }
      res.json({ leadSheet: out.leadSheet, improvTips: out.improvTips });
    } catch (e) {
      console.error('realbook-lead-sheet', e);
      res.status(500).json({ error: e.message || 'Lead sheet failed' });
    }
  });

  app.post('/api/chords/realbook-remix', requireXai, async (req, res) => {
    const { title, artist, originalGenre, targetGenre, originalLeadSheet } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    if (!targetGenre || typeof targetGenre !== 'string') {
      return res.status(400).json({ error: 'targetGenre required' });
    }
    const og = originalGenre || 'General';
    const a = (artist && String(artist)) || 'Unknown';
    const sheet = originalLeadSheet && String(originalLeadSheet).slice(0, 14000);
    const system = `You adapt chord progressions across genres for a modern Real Book. Output ONLY valid JSON.`;
    const user = `Remix "${title}" by ${a}: chords from "${og}" to "${targetGenre}" for a modern Real Book—include variations and why it works.

${sheet ? `Original lead sheet context:\n${sheet}\n` : ''}

Return JSON:
{"originalSummary":"string","remixedLeadSheet":"string","variations":["string"],"whyItWorks":"string"}`;
    try {
      const out = await xaiJson({ apiKey: req._xaiKey, system, user, maxTokens: 8000 });
      if (typeof out.remixedLeadSheet !== 'string') {
        return res.status(502).json({ error: 'Invalid remix response' });
      }
      res.json({
        originalSummary: out.originalSummary || '',
        remixedLeadSheet: out.remixedLeadSheet,
        variations: Array.isArray(out.variations) ? out.variations : [],
        whyItWorks: out.whyItWorks || '',
      });
    } catch (e) {
      console.error('realbook-remix', e);
      res.status(500).json({ error: e.message || 'Remix failed' });
    }
  });

  app.post('/api/chords/realbook-search', requireXai, async (req, res) => {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query required' });
    }
    const q = query.trim().slice(0, 280);
    const system = `You create Real Book-style charts for any song across music styles. Infer genre when possible. Output ONLY valid JSON.`;
    const user = `Generate a complete Real Book-style chart for: "${q}"

Infer title, artist, genre, and year when possible. Include key, tempo, chord progression with abbreviated lyrics, brief melody hint, and improv ideas spanning useful performance approaches.

Return JSON:
{"title":"string","artist":"string","genre":"string","year":number or null,"leadSheet":"string","improvTips":["string"]}`;
    try {
      const out = await xaiJson({ apiKey: req._xaiKey, system, user, maxTokens: 8000 });
      if (typeof out.leadSheet !== 'string' || typeof out.title !== 'string') {
        return res.status(502).json({ error: 'Invalid AI response' });
      }
      res.json({
        title: out.title,
        artist: out.artist || 'Unknown',
        genre: out.genre || 'Various',
        year: typeof out.year === 'number' ? out.year : null,
        leadSheet: out.leadSheet,
        improvTips: Array.isArray(out.improvTips) ? out.improvTips : [],
      });
    } catch (e) {
      console.error('realbook-search', e);
      res.status(500).json({ error: e.message || 'Search generation failed' });
    }
  });

  app.post('/api/chords/realbook-suggest', requireXai, async (req, res) => {
    const { title, artist, genre, year, note } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    ensureDataDir();
    const system = `You curate a multi-genre Real Book. Output ONLY valid JSON.`;
    const user = `Is "${title}"${artist ? ` by ${artist}` : ''} worth including in a multi-genre Real Book (pedagogy + gig usefulness)?

Meta: genre=${genre || 'unknown'}, year=${year ?? 'unknown'}, submitter note=${note || 'none'}

Return JSON:
{"worthy":boolean,"reason":"string","sampleChart":"if worthy, short Real Book mini-chart; else empty string"}`;
    try {
      const ai = await xaiJson({ apiKey: req._xaiKey, system, user, maxTokens: 4500 });
      const entry = {
        title: title.trim(),
        artist: (artist && String(artist).trim()) || 'Unknown',
        genre: genre || null,
        year: year != null && !Number.isNaN(Number(year)) ? Number(year) : null,
        note: (note && String(note)) || '',
        submittedAt: new Date().toISOString(),
        aiWorthy: !!ai.worthy,
        aiReason: ai.reason || '',
        sampleChart: typeof ai.sampleChart === 'string' ? ai.sampleChart : '',
      };
      const list = safeReadJson(SUGGESTIONS_FILE, []);
      const arr = Array.isArray(list) ? list : [];
      arr.push(entry);
      fs.writeFileSync(SUGGESTIONS_FILE, JSON.stringify(arr, null, 2), 'utf8');
      res.json({
        worthy: !!ai.worthy,
        reason: ai.reason || '',
        sampleChart: entry.sampleChart,
        stored: true,
      });
    } catch (e) {
      console.error('realbook-suggest', e);
      res.status(500).json({ error: e.message || 'Suggest failed' });
    }
  });

  app.post('/api/chords/realbook-add-to-book', (req, res) => {
    ensureDataDir();
    const body = req.body || {};
    const {
      title, artist, genre, year, leadSheet, improvTips, id,
    } = body;
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title required' });
    const gid = (id && String(id).startsWith('rb-')) ? String(id) : `rb-x-${Date.now().toString(36)}`;
    const song = {
      id: gid,
      title: title.trim(),
      artist: (artist && String(artist).trim()) || 'Unknown',
      genre: (genre && String(genre).trim()) || 'Various',
      year: year != null && !Number.isNaN(Number(year)) ? Number(year) : new Date().getFullYear(),
      addedAt: new Date().toISOString(),
      source: 'user-search',
      previewLeadSheet: leadSheet ? String(leadSheet).slice(0, 800) : '',
      improvTips: Array.isArray(improvTips) ? improvTips.slice(0, 24) : [],
    };
    try {
      const ext = safeReadJson(EXTENSIONS_FILE, []);
      const arr = Array.isArray(ext) ? ext : [];
      if (arr.some((s) => s.title === song.title && s.artist === song.artist)) {
        return res.status(400).json({ error: 'Already in community extensions list' });
      }
      arr.push(song);
      fs.writeFileSync(EXTENSIONS_FILE, JSON.stringify(arr, null, 2), 'utf8');
      res.json({ ok: true, song });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerChordsApi };
