require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'beethovan-dev-secret-change-in-production';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const FREE_SAVE_LIMIT = 10;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CHORD_REFERENCE_FILE = path.join(DATA_DIR, 'chord-reference.json');
const CHORDONOMICON_INDEX_FILE = path.join(DATA_DIR, 'chordonomicon-index.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  try {
    const data = fs.readFileSync(STORE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { users: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// RAG: Load chord reference and search by query (title + artist)
function loadChordReference() {
  try {
    if (!fs.existsSync(CHORD_REFERENCE_FILE)) return [];
    const data = fs.readFileSync(CHORD_REFERENCE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function searchChordReference(query) {
  const top = searchChordReferenceTopK(query, 1);
  return top.length > 0 ? top[0] : null;
}

function searchChordReferenceTopK(query, k = 2) {
  const refs = loadChordReference();
  if (refs.length === 0) return [];
  const rawQuery = (query || '').trim();
  const q = rawQuery.toLowerCase().replace(/[^\w\s\u4e00-\u9fff\uac00-\ud7af\u3040-\u309f]/g, ' ').replace(/\s+/g, ' ').trim();
  const qWords = q.split(' ').filter(w => w.length > 0);
  const hasCJK = /[\u4e00-\u9fff\uac00-\ud7af\u3040-\u309f]/.test(rawQuery);

  const scored = [];
  for (const ref of refs) {
    const title = (ref.title || '').toLowerCase();
    const artist = (ref.artist || '').toLowerCase();
    const aliases = (ref.aliases || []).map(a => (a || '').toLowerCase());
    const combined = `${title} ${artist} ${aliases.join(' ')}`;

    let score = 0;
    if (hasCJK || rawQuery.length >= 2) {
      const qNorm = rawQuery.replace(/\s+/g, '').toLowerCase();
      const combinedNorm = (title + artist + aliases.join('')).replace(/\s+/g, '');
      if (combinedNorm.includes(qNorm) || combined.toLowerCase().includes(qNorm)) score = Math.max(score, 0.7);
      if (qNorm.includes(combinedNorm) || qNorm.includes(title) || qNorm.includes(artist)) score = Math.max(score, 0.6);
    }
    if (qWords.length > 0) {
      const matched = qWords.filter(w => combined.includes(w)).length;
      score = Math.max(score, matched / Math.max(1, qWords.length));
    }
    if (score >= 0.3) scored.push({ ref, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.ref);
}

// Chordonomicon: Load index for Spotify ID lookups (built by scripts/build_chordonomicon.py)
function loadChordonomiconIndex() {
  try {
    if (!fs.existsSync(CHORDONOMICON_INDEX_FILE)) return null;
    const data = fs.readFileSync(CHORDONOMICON_INDEX_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function searchChordonomiconBySpotifyId(spotifyId) {
  const index = loadChordonomiconIndex();
  if (!index || !Array.isArray(index)) return null;
  const found = index.find(s => (s.spotifyId || '').toLowerCase() === (spotifyId || '').toLowerCase());
  return found ? { title: found.title, artist: found.artist, progressions: found.progressions } : null;
}

// Chordonomicon search by query (title + artist) - no Spotify needed
function searchChordonomiconByQuery(query) {
  const index = loadChordonomiconIndex();
  if (!index || !Array.isArray(index)) return null;
  const rawQuery = (query || '').trim();
  const q = rawQuery.toLowerCase().replace(/[^\w\s\u4e00-\u9fff\uac00-\ud7af\u3040-\u309f]/g, ' ').replace(/\s+/g, ' ').trim();
  const qWords = q.split(' ').filter(w => w.length > 0);
  const hasCJK = /[\u4e00-\u9fff\uac00-\ud7af\u3040-\u309f]/.test(rawQuery);

  let best = null;
  let bestScore = 0;
  for (const ref of index) {
    const title = (ref.title || '').toLowerCase();
    const artist = (ref.artist || '').toLowerCase();
    const combined = `${title} ${artist}`;

    let score = 0;
    if (hasCJK || rawQuery.length >= 2) {
      const qNorm = rawQuery.replace(/\s+/g, '').toLowerCase();
      const combinedNorm = (title + artist).replace(/\s+/g, '');
      if (combinedNorm.includes(qNorm) || combined.includes(qNorm)) score = Math.max(score, 0.7);
      if (qNorm.includes(combinedNorm) || qNorm.includes(title) || qNorm.includes(artist)) score = Math.max(score, 0.6);
    }
    if (qWords.length > 0) {
      const matched = qWords.filter(w => combined.includes(w)).length;
      score = Math.max(score, matched / Math.max(1, qWords.length));
    }
    if (score >= 0.5 && score > bestScore) {
      bestScore = score;
      best = ref;
    }
  }
  return best ? { title: best.title, artist: best.artist, progressions: best.progressions } : null;
}

app.use(cors({ origin: true }));

// Ensure user tier reflects subscription status (expired = free)
function ensureSubscriptionTier(user) {
  if (user.tier !== 'unlimited') return;
  const periodEnd = user.subscriptionPeriodEnd;
  if (periodEnd && new Date(periodEnd) < new Date()) {
    user.tier = 'free';
    user.subscriptionId = undefined;
    user.subscriptionPeriodEnd = undefined;
  }
}

// Stripe webhook must get raw body (register before express.json())
app.post(
  '/api/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !stripe) {
      return res.status(400).send('Webhook not configured');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (e) {
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId || session.client_reference_id;
      if (userId && session.mode === 'subscription' && session.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const store = loadStore();
          const user = store.users.find(u => u.id === userId);
          if (user) {
            user.tier = 'unlimited';
            user.subscriptionId = subscription.id;
            user.subscriptionPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
            saveStore(store);
            console.log('User subscribed to unlimited:', user.email, 'until', user.subscriptionPeriodEnd);
          }
        } catch (e) {
          console.error('Webhook subscription fetch error:', e);
        }
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const store = loadStore();
      const user = store.users.find(u => u.subscriptionId === sub.id);
      if (user) {
        if (sub.status === 'active' || sub.status === 'trialing') {
          user.subscriptionPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
        } else {
          // Canceled, past_due, unpaid, etc. - access until period end
          user.subscriptionPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
          ensureSubscriptionTier(user);
        }
        saveStore(store);
        console.log('Subscription updated for', user.email, 'period end:', user.subscriptionPeriodEnd);
      }
    }
    res.json({ received: true });
  }
);

app.use(express.json());

// Serve frontend (index.html, script.js, style.css) from parent directory
app.use(express.static(path.join(__dirname, '..')));

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth ---
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const store = loadStore();
  if (store.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: genId(),
    email: email.toLowerCase(),
    passwordHash: hash,
    tier: 'free',
    savedSongs: [],
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  saveStore(store);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { email: user.email, tier: user.tier, savedCount: 0 } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const store = loadStore();
  const user = store.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: {
      email: user.email,
      tier: user.tier,
      savedCount: (user.savedSongs || []).length,
    },
  });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const store = loadStore();
  const user = store.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  ensureSubscriptionTier(user);
  if (user.tier === 'free' && user.subscriptionId) {
    user.subscriptionId = undefined;
    user.subscriptionPeriodEnd = undefined;
    saveStore(store);
  }
  res.json({
    email: user.email,
    tier: user.tier,
    savedCount: (user.savedSongs || []).length,
  });
});

// --- Saved songs ---
app.get('/api/saved-songs', authMiddleware, (req, res) => {
  const store = loadStore();
  const user = store.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.savedSongs || []);
});

app.post('/api/saved-songs', authMiddleware, (req, res) => {
  const store = loadStore();
  const user = store.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  ensureSubscriptionTier(user);
  if (user.tier === 'free' && user.subscriptionId) {
    user.subscriptionId = undefined;
    user.subscriptionPeriodEnd = undefined;
    saveStore(store);
  }
  const song = req.body;
  if (!song || !song.title) {
    return res.status(400).json({ error: 'Invalid song data' });
  }
  user.savedSongs = user.savedSongs || [];
  const exists = user.savedSongs.some(
    s => s.title === song.title && (s.artist || '') === (song.artist || '')
  );
  if (exists) {
    return res.status(400).json({ error: 'Song already saved' });
  }
  const isUnlimited = user.tier === 'unlimited';
  if (!isUnlimited && user.savedSongs.length >= FREE_SAVE_LIMIT) {
    return res.status(403).json({
      error: 'Save limit reached',
      limit: FREE_SAVE_LIMIT,
      message: 'Upgrade to unlimited ($1/month or $10/year) to save more songs.',
    });
  }
  user.savedSongs.push({
    ...song,
    savedAt: new Date().toISOString(),
  });
  saveStore(store);
  res.json({ saved: true, savedCount: user.savedSongs.length });
});

app.delete('/api/saved-songs/:index', authMiddleware, (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const store = loadStore();
  const user = store.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.savedSongs = user.savedSongs || [];
  if (index >= user.savedSongs.length) {
    return res.status(404).json({ error: 'Song not found' });
  }
  user.savedSongs.splice(index, 1);
  saveStore(store);
  res.json({ removed: true, savedCount: user.savedSongs.length });
});

// --- Chord feedback (store user corrections) ---
const CHORD_FEEDBACK_FILE = path.join(DATA_DIR, 'chord-feedback.json');

app.post('/api/chord-feedback', (req, res) => {
  const body = req.body || {};
  const { title, artist, progressions, correctedText } = body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title required' });
  }
  try {
    let feedback = [];
    if (fs.existsSync(CHORD_FEEDBACK_FILE)) {
      feedback = JSON.parse(fs.readFileSync(CHORD_FEEDBACK_FILE, 'utf8'));
    }
    feedback.push({
      title,
      artist: artist || '',
      progressions: progressions || [],
      correctedText: correctedText || null,
      reportedAt: new Date().toISOString()
    });
    fs.writeFileSync(CHORD_FEEDBACK_FILE, JSON.stringify(feedback, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    console.error('Chord feedback error:', e);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// --- RAG: Chord lookup (for client to use with Xai) ---
// Priority: 1) Chordonomicon by Spotify ID, 2) Chordonomicon by query, 3) chord-reference
app.get('/api/chord-lookup', (req, res) => {
  const q = req.query.q;
  const spotifyId = req.query.spotifyId;

  // 1. Try Chordonomicon by Spotify ID if present
  if (spotifyId && typeof spotifyId === 'string') {
    const chordonomicon = searchChordonomiconBySpotifyId(spotifyId);
    if (chordonomicon) {
      return res.json({ found: true, song: chordonomicon, source: 'chordonomicon' });
    }
  }

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Query parameter q required' });
  }

  // 2. Try Chordonomicon by title/artist (no Spotify needed)
  const chordonomiconByQuery = searchChordonomiconByQuery(q);
  if (chordonomiconByQuery) {
    return res.json({ found: true, song: chordonomiconByQuery, source: 'chordonomicon' });
  }

  // 3. Fall back to chord-reference
  const ref = searchChordReference(q);
  if (ref) {
    return res.json({ found: true, song: ref, source: 'chord-reference' });
  }
  // No match: return top-k suggestions for RAG context
  const suggestions = searchChordReferenceTopK(q, 2);
  res.json({ found: false, suggestions });
});

// --- Xai AI proxy (avoids CORS - browser cannot call api.x.ai directly) ---
app.post('/api/generate-chord-chart-xai', async (req, res) => {
  if (!XAI_API_KEY) {
    return res.status(503).json({
      error: 'Xai AI is not configured. Set XAI_API_KEY in server/.env',
    });
  }
  const { songQuery, ragContext } = req.body || {};
  if (!songQuery || typeof songQuery !== 'string') {
    return res.status(400).json({ error: 'songQuery required' });
  }

  const systemPrompt = `You are an expert at guitar and piano chord charts. Your goal is accuracy.
- NEVER invent chord progressions. Only return progressions you have high confidence in from real transcriptions (official tabs, chord sheets, or widely accepted versions).
- When uncertain, prefer returning fewer sections rather than inventing chords. Do NOT guess for obscure or lesser-known songs.
- Give the real chord progression used in the actual song (as heard on the record or in common tabs).
- Use the correct key (e.g. capo = write in concert key, or state key and use common chord shapes).
- Use standard notation: C, Dm, Em, F, G, Am, Bdim, C7, F#m, Bb, etc. Include sharps/flats when needed.
- Match the song structure: Verse, Chorus, Bridge, Intro, Outro. Repeat the same progression for the same section (e.g. Verse 1 and Verse 2 share the same chords).
- If the song uses a well-known progression (e.g. I-V-vi-IV, I-vi-IV-V), use that. Do not invent progressions—prefer the standard one for that song.
- Support songs in ANY language: English, Cantonese, Mandarin, Korean, Japanese, etc. Use the original title and artist name as commonly written.
- Output only valid JSON, no markdown or extra text.`;

  const fewShot = `Examples of accurate chord charts (from Ultimate Guitar, official tabs):
- "Let It Be" by Beatles: Verse [C, G, Am, F, C, G, F, C], Chorus [C, G, Am, F, C, G, F, C]
- "Wonderwall" by Oasis: Intro [Em7, G, Dsus4, A7sus4], Verse [Em7, G, Dsus4, A7sus4], Chorus [C, D, Em7, G]
- "Tears in Heaven" by Eric Clapton: Intro [A, E/G#, F#m, A/E, D/F#, E7sus4, E7, A], Verse [F#m, C#m, Bm, A], Chorus [A, E, F#m, A/E, D/F#, A/E, E]
- "Hotel California" by Eagles: Intro [Bm, F#, A, E, G, D, Em, F#], Verse [Bm, F#, A, E, G, D, Em, F#]
- "海闊天空" by Beyond: Verse [Dm, Bb, C, F, Bb, C, Dm], Chorus [F, Bb, C, Dm, Bb, C, F]
- "Gangnam Style" by PSY: Verse [Bm, G, D, A], Chorus [Bm, G, D, A]
- For obscure songs: return only 1–2 sections with chords you are confident about; omit sections you would have to guess.`;

  const prompt = `Chord chart for: "${songQuery}"
${ragContext || ''}

${fewShot}

Return the actual chord progression for this song (the one used in real chord sheets / tabs). 

CRITICAL: You must return ONLY valid JSON. No markdown, no code blocks, no explanations, no additional text. Start with { and end with }.

Use this JSON structure. For chord-over-lyric display, include "parts" in each progression (chord + lyric chunk pairs). If you don't know lyrics, omit "parts" and use only "chords":

{
  "title": "Exact Song Title",
  "artist": "Artist Name",
  "progressions": [
    { "label": "Intro", "chords": ["A", "E", "F#m", "A/E"] },
    { "label": "Chorus", "chords": ["A", "E", "F#m", "A/E"], "parts": [
      { "chord": "A", "lyric": "Would " },
      { "chord": "E", "lyric": "you " },
      { "chord": "F#m", "lyric": "know my " },
      { "chord": "A/E", "lyric": "name" }
    ] },
    { "label": "Verse", "chords": ["F#m", "C#m", "Bm"], "parts": [
      { "chord": "F#m", "lyric": "I must be " },
      { "chord": "C#m", "lyric": "strong " },
      { "chord": "Bm", "lyric": "and carry on" }
    ] }
  ]
}

Rules: Include "parts" (array of {chord, lyric}) when you know the lyrics—each chord aligns above its lyric chunk. Omit "parts" for instrumental sections or when unsure. 2–4 sections. Return ONLY the JSON object.`;

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
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
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('Xai API error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'Xai API request failed',
        details: errorText.slice(0, 300),
      });
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: 'Invalid Xai response structure' });
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch) content = jsonMatch[1];
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) content = jsonObjectMatch[0];

    let songData;
    try {
      songData = JSON.parse(content.trim());
    } catch (parseError) {
      const aggressiveMatch = content.match(/\{[\s\S]*"title"[\s\S]*"progressions"[\s\S]*\}/);
      if (aggressiveMatch) songData = JSON.parse(aggressiveMatch[0]);
      else {
        return res.status(502).json({ error: 'Invalid JSON in Xai response', raw: content.slice(0, 200) });
      }
    }
    if (!songData.title || !songData.progressions || !Array.isArray(songData.progressions)) {
      return res.status(502).json({ error: 'Invalid response structure - missing title or progressions' });
    }

    res.json({ song: songData, source: 'ai' });
  } catch (e) {
    console.error('Xai proxy error:', e);
    res.status(500).json({ error: 'Failed to generate chord chart', details: e.message });
  }
});

// --- Free AI proxy (no auth required) ---
app.post('/api/generate-chords', async (req, res) => {
  if (!DEEPSEEK_API_KEY) {
    return res.status(503).json({
      error: 'Free AI search is not configured. Set DEEPSEEK_API_KEY on the server.',
    });
  }
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query required' });
  }

  // RAG: Top-k chord reference for context
  const ragRefs = searchChordReferenceTopK(query, 2);
  const ragContext = ragRefs.length > 0
    ? '\nSIMILAR REFERENCE SONGS (use as style/structure guide if relevant):\n' +
      ragRefs.map(r => JSON.stringify({ title: r.title, artist: r.artist, progressions: r.progressions })).join('\n') + '\n'
    : '';

  const systemPrompt = `You are an expert at guitar and piano chord charts. Your goal is accuracy.
- NEVER invent chord progressions. Only return progressions you have high confidence in from real transcriptions (official tabs, chord sheets, or widely accepted versions).
- When unsure, use common progressions for that song; if none exist, return fewer sections.
- Give the real chord progression used in the actual song (as heard on the record or in common tabs).
- Use the correct key (e.g. capo = write in concert key, or state key and use common chord shapes).
- Use standard notation: C, Dm, Em, F, G, Am, Bdim, C7, F#m, Bb, etc. Include sharps/flats when needed.
- Match the song structure: Verse, Chorus, Bridge, Intro, Outro. Repeat the same progression for the same section (e.g. Verse 1 and Verse 2 share the same chords).
- If the song uses a well-known progression (e.g. I-V-vi-IV, I-vi-IV-V), use that. Do not invent progressions—prefer the standard one for that song.
- Support songs in ANY language: English, Cantonese, Mandarin, Korean, Japanese, etc. Use the original title and artist name as commonly written.
- Output only valid JSON, no markdown or extra text.`;

  const fewShot = `Examples of accurate chord charts:
- "Let It Be" by Beatles: Verse [C, G, Am, F, C, G, F, C], Chorus [C, G, Am, F, C, G, F, C]
- "Wonderwall" by Oasis: Intro [Em7, G, Dsus4, A7sus4], Verse [Em7, G, Dsus4, A7sus4]
- "海闊天空" by Beyond: Verse [Dm, Bb, C, F, Bb, C, Dm], Chorus [F, Bb, C, Dm, Bb, C, F]
- "Gangnam Style" by PSY: Verse [Bm, G, D, A], Chorus [Bm, G, D, A]
`;

  const prompt = `Chord chart for: "${query}"
${ragContext}

${fewShot}

Return the actual chord progression for this song (the one used in real chord sheets / tabs). Use this exact JSON structure only:

{
  "title": "Exact Song Title",
  "artist": "Artist Name",
  "progressions": [
    { "label": "Intro", "chords": ["C", "G", "Am", "F"] },
    { "label": "Verse", "chords": ["C", "G", "Am", "F"] },
    { "label": "Chorus", "chords": ["F", "G", "C", "Am"] }
  ]
}

Rules: 2–4 sections (Intro, Verse, Chorus, Bridge, etc.). 4–8 chords per section. Same section name = same chord list. No lyrics. Only valid JSON.`;

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 1200,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: 'AI request failed',
        details: errText.slice(0, 200),
      });
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: 'Invalid AI response' });
    }

    const jsonMatch =
      content.match(/```json\s*([\s\S]*?)\s*```/) ||
      content.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch) content = jsonMatch[1];
    const songData = JSON.parse(content.trim());
    if (!songData.title || !songData.progressions || !Array.isArray(songData.progressions)) {
      return res.status(502).json({ error: 'Invalid chord chart structure' });
    }
    res.json(songData);
  } catch (e) {
    console.error('AI proxy error:', e);
    res.status(500).json({ error: 'Failed to generate chords' });
  }
});

// --- Stripe subscription ($1/mo or $10/yr) ---
app.post('/api/create-checkout-session', authMiddleware, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({
      error: 'Payments not configured. Set STRIPE_SECRET_KEY and price IDs.',
    });
  }
  const plan = (req.body?.plan || 'monthly').toLowerCase();
  const priceId = plan === 'yearly'
    ? process.env.STRIPE_PRICE_ID_YEARLY
    : process.env.STRIPE_PRICE_ID_MONTHLY;
  if (!priceId) {
    return res.status(503).json({
      error: plan === 'yearly' ? 'STRIPE_PRICE_ID_YEARLY not set' : 'STRIPE_PRICE_ID_MONTHLY not set',
    });
  }
  const origin = req.headers.origin || req.get('referer') || 'http://localhost:3000';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${origin.replace(/\/$/, '')}?payment=success`,
      cancel_url: `${origin.replace(/\/$/, '')}?payment=cancelled`,
      client_reference_id: req.userId,
      metadata: { userId: req.userId },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe session error:', e);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

app.listen(PORT, () => {
  console.log(`Beethovan.ai server on http://localhost:${PORT}`);
  if (!DEEPSEEK_API_KEY) console.log('Warning: DEEPSEEK_API_KEY not set — free AI search disabled');
  if (!XAI_API_KEY) console.log('Warning: XAI_API_KEY not set — Xai chord charts disabled (CORS-safe proxy)');
  if (!stripe) console.log('Info: Stripe not set — upgrade flow will show "not configured"');
});
