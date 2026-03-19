require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const db = require('./db');
const { registerChordsApi } = require('./api/chords');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'beethovan-dev-secret-change-in-production';
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const FREE_SAVE_LIMIT = 10;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const DATA_DIR = path.join(__dirname, 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');

// CORS: localhost (dev) + beethovan.ai (production). Add more via CORS_ORIGINS env.
const defaultOrigins = [
  'http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://localhost:3009', 'http://127.0.0.1:3009',
  'https://beethovan.ai', 'https://www.beethovan.ai', 'http://beethovan.ai', 'http://www.beethovan.ai',
];
const extraOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = [...defaultOrigins, ...extraOrigins];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(null, false);
  },
}));

// Ensure user tier reflects subscription status (expired = free)
function ensureSubscriptionTier(user) {
  if (user.tier !== 'unlimited') return user;
  const periodEnd = user.subscriptionPeriodEnd;
  if (periodEnd && new Date(periodEnd) < new Date()) {
    db.updateUser(user.id, { tier: 'free', subscriptionId: null, subscriptionPeriodEnd: null });
    return db.getUserById(user.id);
  }
  return user;
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
          const user = db.getUserById(userId);
          if (user) {
            db.updateUser(userId, {
              tier: 'unlimited',
              subscriptionId: subscription.id,
              subscriptionPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            });
            db.syncEmailList();
            console.log('User subscribed to unlimited:', user.email, 'until', new Date(subscription.current_period_end * 1000).toISOString());
          }
        } catch (e) {
          console.error('Webhook subscription fetch error:', e);
        }
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const users = db.getDb().prepare('SELECT id FROM users WHERE subscription_id = ?').all(sub.id);
      if (users.length > 0) {
        const userId = users[0].id;
        const user = db.getUserById(userId);
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
        db.updateUser(userId, { subscriptionPeriodEnd: periodEnd });
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          ensureSubscriptionTier({ ...user, subscriptionPeriodEnd: periodEnd });
        }
        db.syncEmailList();
        console.log('Subscription updated for', user.email, 'period end:', periodEnd);
      }
    }
    res.json({ received: true });
  }
);

app.use(express.json());

// Real Book + lead-sheet APIs (xAI); see server/api/chords.js
registerChordsApi(app, { getXaiKey: () => XAI_API_KEY });

const REALBOOK_HTML = path.resolve(__dirname, '..', 'realbook.html');
function sendRealbookPage(req, res) {
  res.sendFile(REALBOOK_HTML, (err) => {
    if (err) {
      console.error('Real Book sendFile:', err.message, REALBOOK_HTML);
      res.status(404).type('text').send(
        'Real Book page missing. Ensure realbook.html is next to index.html, Dropbox has synced, then restart: cd server && npm start'
      );
    }
  });
}
// Trailing slash would break relative /realbook.css in HTML; normalize to /realbook
app.get('/realbook/', (req, res) => res.redirect(302, '/realbook'));
app.get('/realbook', sendRealbookPage);

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
  if (db.getUserByEmail(email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = db.createUser(email, hash);
  db.syncEmailList();
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { email: user.email, tier: user.tier, savedCount: 0 } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = db.getUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const savedSongs = db.getSavedSongs(user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: {
      email: user.email,
      tier: user.tier,
      savedCount: savedSongs.length,
    },
  });
});

app.get('/api/me', authMiddleware, (req, res) => {
  let user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = ensureSubscriptionTier(user);
  if (user.tier === 'free' && user.subscriptionId) {
    db.updateUser(user.id, { subscriptionId: null, subscriptionPeriodEnd: null });
    user = db.getUserById(user.id);
  }
  const savedCount = db.getSavedSongs(user.id).length;
  res.json({
    email: user.email,
    tier: user.tier,
    savedCount,
  });
});

// --- Saved songs ---
app.get('/api/saved-songs', authMiddleware, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(db.getSavedSongs(user.id));
});

app.post('/api/saved-songs', authMiddleware, (req, res) => {
  let user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user = ensureSubscriptionTier(user);
  if (user.tier === 'free' && user.subscriptionId) {
    db.updateUser(user.id, { subscriptionId: null, subscriptionPeriodEnd: null });
    user = db.getUserById(user.id);
  }
  const song = req.body;
  if (!song || !song.title) {
    return res.status(400).json({ error: 'Invalid song data' });
  }
  const savedSongs = db.getSavedSongs(user.id);
  const isUnlimited = user.tier === 'unlimited';
  if (!isUnlimited && savedSongs.length >= FREE_SAVE_LIMIT) {
    return res.status(403).json({
      error: 'Save limit reached',
      limit: FREE_SAVE_LIMIT,
      message: 'Upgrade to unlimited ($1/month or $10/year) to save more songs.',
    });
  }
  const result = db.addSavedSong(user.id, song);
  if (result.exists) {
    return res.status(400).json({ error: 'Song already saved' });
  }
  db.syncEmailList();
  res.json({ saved: true, savedCount: result.count });
});

app.delete('/api/saved-songs/:index', authMiddleware, (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ok = db.removeSavedSongByIndex(user.id, index);
  if (!ok) return res.status(404).json({ error: 'Song not found' });
  db.syncEmailList();
  const savedCount = db.getSavedSongs(user.id).length;
  res.json({ removed: true, savedCount });
});

// --- Feedback (Report inaccurate) ---
function loadFeedback() {
  try {
    const data = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveFeedback(arr) {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

app.post('/api/feedback', (req, res) => {
  const { title, artist, originalProgressions, correctedProgressions, note } = req.body || {};
  if (!title || !note || typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'title and note (description of what\'s wrong) required' });
  }
  const feedback = loadFeedback();
  feedback.push({
    title,
    artist: artist || 'Unknown',
    originalProgressions: originalProgressions || [],
    correctedProgressions: Array.isArray(correctedProgressions) ? correctedProgressions : null,
    note: note.trim(),
    reportedAt: new Date().toISOString(),
  });
  saveFeedback(feedback);
  res.json({ ok: true, message: 'Thank you for the correction!' });
});

// --- Chord generation (unified: Xai, Groq) ---
const CHORD_SYSTEM_PROMPT = `You are an expert at guitar and piano chord charts. Your goal is accuracy.
- NEVER invent chord progressions. Only return progressions you have high confidence in from real transcriptions (official tabs, chord sheets, or widely accepted versions).
- When uncertain, prefer returning fewer sections rather than inventing chords. Do NOT guess for obscure or lesser-known songs.
- Give the real chord progression used in the actual song (as heard on the record or in common tabs).
- Use the correct key (e.g. capo = write in concert key, or state key and use common chord shapes).
- Use standard notation: C, Dm, Em, F, G, Am, Bdim, C7, F#m, Bb, etc. Include sharps/flats when needed.
- Use exact sus4, sus2, 7sus4 when the song uses them (e.g. Wonderwall uses Dsus4 and A7sus4, not plain D and A).
- Match the song structure: Verse, Chorus, Bridge, Intro, Outro. Repeat the same progression for the same section (e.g. Verse 1 and Verse 2 share the same chords).
- If the song uses a well-known progression (e.g. I-V-vi-IV, I-vi-IV-V), use that. Do not invent progressions—prefer the standard one for that song.
- Support songs in ANY language: English, Cantonese, Mandarin, Korean, Japanese, etc. Use the original title and artist name as commonly written.
- Output only valid JSON, no markdown or extra text.`;

const CHORD_FEW_SHOT = `Examples of accurate chord charts (from Ultimate Guitar, official tabs):
- "Let It Be" by Beatles: Verse [C, G, Am, F, C, G, F, C], Chorus [C, G, Am, F, C, G, F, C]
- "Wonderwall" by Oasis: Intro [Em7, G, Dsus4, A7sus4], Verse [Em7, G, Dsus4, A7sus4], Chorus [C, D, Em7, G] — use Dsus4 and A7sus4, not D and A
- "Tears in Heaven" by Eric Clapton: Intro [A, E/G#, F#m, A/E, D/F#, E7sus4, E7, A], Verse [F#m, C#m, Bm, A], Chorus [A, E, F#m, A/E, D/F#, A/E, E]
- "Hotel California" by Eagles: Intro [Bm, F#, A, E, G, D, Em, F#], Verse [Bm, F#, A, E, G, D, Em, F#]
- "Brown Eyed Girl" by Van Morrison: Verse [G, C, G, D], Chorus [G, C, G, D, G, C, G, D] — simple I-IV-I-V
- "Stand By Me" by Ben E. King: Verse [A, F#m, D, E] or [C, Am, F, G] — I-vi-IV-V
- "Tears in Heaven" by Eric Clapton: Intro [A, E/G#, F#m, A/E, D/F#, E7sus4, E7, A], Verse [F#m, C#m, Bm, A], Chorus [A, E, F#m, A/E, D/F#, A/E, E] — use slash chords
- "海闊天空" by Beyond: Verse [Dm, Bb, C, F, Bb, C, Dm], Chorus [F, Bb, C, Dm, Bb, C, F]
- "Gangnam Style" by PSY: Verse [Bm, G, D, A], Chorus [Bm, G, D, A]
- For obscure songs: return only 1–2 sections with chords you are confident about; omit sections you would have to guess.`;

const CHORD_JSON_STRUCTURE = `{
  "title": "Exact Song Title",
  "artist": "Artist Name",
  "progressions": [
    { "label": "Intro", "chords": ["A", "E", "F#m", "A/E"] },
    { "label": "Verse", "chords": ["F#m", "C#m", "Bm"], "parts": [
      { "chord": "F#m", "lyric": "I must be " },
      { "chord": "C#m", "lyric": "strong " },
      { "chord": "Bm", "lyric": "and carry on" }
    ] },
    { "label": "Chorus", "chords": ["A", "E", "F#m", "A/E"], "parts": [
      { "chord": "A", "lyric": "Would " },
      { "chord": "E", "lyric": "you " },
      { "chord": "F#m", "lyric": "know my " },
      { "chord": "A/E", "lyric": "name" }
    ] }
  ]
}

Rules: Include "parts" for Verse, Chorus, Bridge—put each chord above the syllable/word it accompanies. Split lyrics into small chunks (1–3 words per chord). Omit "parts" only for instrumental Intro/Outro. 2–4 sections. Return ONLY the JSON object.`;

function buildSpotifyHint(spotifyId, spotifyMetadata) {
  if (!spotifyId) return '';
  let hint = `\nSpotify track ID: ${spotifyId} (use for disambiguation if needed).`;
  if (spotifyMetadata && typeof spotifyMetadata === 'string') {
    hint += `\nSpotify metadata: ${spotifyMetadata}. Use this key and tempo to improve chord accuracy.`;
  }
  return hint;
}

async function generateWithXai(songQuery, spotifyId, spotifyMetadata) {
  const spotifyHint = buildSpotifyHint(spotifyId, spotifyMetadata);
  const prompt = `Chord chart for: "${songQuery}"${spotifyHint}

${CHORD_FEW_SHOT}

Return the actual chord progression for this song (the one used in real chord sheets / tabs). 

CRITICAL: You must return ONLY valid JSON. No markdown, no code blocks, no explanations, no additional text. Start with { and end with }.

Use this JSON structure. ALWAYS include "parts" (chord + lyric pairs) for sections with lyrics. Each chord aligns above its lyric chunk:

${CHORD_JSON_STRUCTURE}`;

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      messages: [
        { role: 'system', content: CHORD_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 4000,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown error');
    throw new Error(`Xai ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function generateWithGroq(songQuery, spotifyId, spotifyMetadata) {
  const spotifyHint = buildSpotifyHint(spotifyId, spotifyMetadata);
  const prompt = `Chord chart for: "${songQuery}"${spotifyHint}

${CHORD_FEW_SHOT}

Return the actual chord progression for this song. Return ONLY valid JSON. No markdown, no code blocks.

${CHORD_JSON_STRUCTURE}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: CHORD_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 4000,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown error');
    throw new Error(`Groq ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

function parseChordJson(content) {
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
    else throw new Error('Invalid JSON in AI response');
  }
  if (!songData.title || !songData.progressions || !Array.isArray(songData.progressions)) {
    throw new Error('Invalid response structure - missing title or progressions');
  }
  return songData;
}

app.post('/api/generate-chord-chart', async (req, res) => {
  const { songQuery, model = 'xai', spotifyId, spotifyMetadata } = req.body || {};
  if (!songQuery || typeof songQuery !== 'string') {
    return res.status(400).json({ error: 'songQuery required' });
  }
  const useModel = (model === 'groq' ? 'groq' : 'xai');
  if (useModel === 'groq' && !GROQ_API_KEY) {
    return res.status(503).json({ error: 'Groq not configured. Set GROQ_API_KEY in server/.env' });
  }
  if (useModel === 'xai' && !XAI_API_KEY) {
    return res.status(503).json({ error: 'Xai AI is not configured. Set XAI_API_KEY in server/.env' });
  }
  try {
    const content = useModel === 'groq'
      ? await generateWithGroq(songQuery, spotifyId || null, spotifyMetadata || null)
      : await generateWithXai(songQuery, spotifyId || null, spotifyMetadata || null);
    if (!content) return res.status(502).json({ error: 'Invalid AI response structure' });
    const songData = parseChordJson(content);
    res.json({ song: songData, source: 'ai', model: useModel });
  } catch (e) {
    console.error('Chord generation error:', e);
    res.status(500).json({ error: e.message || 'Failed to generate chord chart', details: e.message });
  }
});

// --- Xai AI proxy (legacy; uses shared generateWithXai) ---
app.post('/api/generate-chord-chart-xai', async (req, res) => {
  const { songQuery, spotifyId, spotifyMetadata } = req.body || {};
  if (!XAI_API_KEY) {
    return res.status(503).json({ error: 'Xai AI is not configured. Set XAI_API_KEY in server/.env' });
  }
  if (!songQuery || typeof songQuery !== 'string') {
    return res.status(400).json({ error: 'songQuery required' });
  }
  try {
    const content = await generateWithXai(songQuery, spotifyId || null, spotifyMetadata || null);
    if (!content) return res.status(502).json({ error: 'Invalid Xai response structure' });
    const songData = parseChordJson(content);
    res.json({ song: songData, source: 'ai', model: 'xai' });
  } catch (e) {
    console.error('Xai proxy error:', e);
    res.status(500).json({ error: e.message || 'Failed to generate chord chart', details: e.message });
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

const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = accept connections from anywhere (for beethovan.ai)
const server = app.listen(PORT, HOST, () => {
  try { db.syncEmailList(); } catch (_) {}
  const localUrl = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Beethovan.ai server on http://${HOST}:${PORT}`);
  console.log(`  Real Book: http://${localUrl}:${PORT}/realbook`);
  if (!XAI_API_KEY) console.log('Warning: XAI_API_KEY not set — chord charts disabled');
  if (!stripe) console.log('Info: Stripe not set — upgrade flow will show "not configured"');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Either:`);
    console.error(`  1) Free it:  kill $(lsof -t -i :${PORT})`);
    console.error(`  2) Or run:  PORT=3010 npm start  →  http://localhost:3010/realbook\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
