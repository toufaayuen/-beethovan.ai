// Backend API base (set window.API_BASE in HTML for dev, e.g. 'http://localhost:3001')
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '';
// Can use server when on http(s) - same-origin uses relative URLs when API_BASE is ''
const CAN_USE_SERVER = typeof window !== 'undefined' && window.location?.protocol?.startsWith('http');

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Auth state
let currentUser = null; // { email, tier, savedCount }
function getToken() {
    return localStorage.getItem('beethovan_ai_token');
}
function getAuthHeader() {
    const token = getToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

// Saved Songs Storage (synced from API when logged in, else localStorage)
let savedSongs = [];

async function loadSavedSongs() {
    if (currentUser) {
        try {
            const res = await fetch(API_BASE + '/api/saved-songs', { headers: getAuthHeader() });
            if (res.ok) {
                savedSongs = await res.json();
                return;
            }
        } catch (e) {
            console.error('Failed to load saved songs', e);
        }
    }
    const saved = localStorage.getItem('beethovan_ai_saved_songs');
    if (saved) {
        savedSongs = JSON.parse(saved);
    } else {
        savedSongs = [];
    }
}

function saveSavedSongsToLocal() {
    localStorage.setItem('beethovan_ai_saved_songs', JSON.stringify(savedSongs));
}

// Add song to saved songs (requires login; free: max 10, paid: unlimited)
async function saveSong(song) {
    if (!currentUser) {
        alert('Please register or log in to save songs. Free: up to 10 songs; $1/month or $10/year for unlimited.');
        openRegister();
        return;
    }
    const exists = savedSongs.some(s =>
        s.title === song.title && (s.artist || '') === (song.artist || '')
    );
    if (exists) {
        alert('Song already saved!');
        return;
    }
    try {
        const res = await fetch(API_BASE + '/api/saved-songs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
            body: JSON.stringify(song)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            await loadSavedSongs();
            if (currentUser) currentUser.savedCount = savedSongs.length;
            updateHeaderAuth();
            alert(`Saved "${song.title}"!`);
            return;
        }
        if (res.status === 403 && data.limit) {
            alert(`You've reached the free limit of ${data.limit} songs. Upgrade to unlimited ($1/month or $10/year) to save more!`);
            document.getElementById('upgradeBtn').click();
            return;
        }
        alert(data.error || 'Failed to save song');
    } catch (e) {
        alert('Network error. Make sure the server is running.');
    }
}

async function removeSavedSong(index) {
    if (!confirm(`Remove "${savedSongs[index].title}" from saved songs?`)) return;
    if (currentUser) {
        try {
            const res = await fetch(API_BASE + '/api/saved-songs/' + index, {
                method: 'DELETE',
                headers: getAuthHeader()
            });
            if (res.ok) {
                await loadSavedSongs();
                if (currentUser) currentUser.savedCount = savedSongs.length;
                updateHeaderAuth();
                renderSavedSongs();
                return;
            }
        } catch (e) {
            console.error(e);
        }
    }
    savedSongs.splice(index, 1);
    saveSavedSongsToLocal();
    renderSavedSongs();
}

// Render saved songs list (optional filter by artist/title)
function renderSavedSongs(filter = '') {
    const savedSongsList = document.getElementById('savedSongsList');
    if (!savedSongsList) return;

    const q = (filter || '').toLowerCase().trim();
    const filtered = q
        ? savedSongs.filter(s => (s.title || '').toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q))
        : savedSongs;

    savedSongsList.innerHTML = '';

    if (savedSongs.length === 0) {
        savedSongsList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No saved songs yet. Save a song to see it here!</p>';
        return;
    }

    if (filtered.length === 0) {
        savedSongsList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No matches for "' + escapeHtml(q) + '"</p>';
        return;
    }

    filtered.forEach((song) => {
        const index = savedSongs.findIndex(s => s.title === song.title && (s.artist || '') === (song.artist || ''));
        if (index < 0) return;
        const songDiv = document.createElement('div');
        songDiv.className = 'saved-song-item';
        const displayTitle = song.titleEn ? `${song.title} (${song.titleEn})` : song.title;
        songDiv.innerHTML = `
            <div class="saved-song-info">
                <h3>${displayTitle}</h3>
                <p>${song.artist || 'Unknown Artist'}</p>
            </div>
            <div class="saved-song-actions">
                <button class="load-song-btn" data-index="${index}">LOAD</button>
                <button class="delete-song-btn" data-index="${index}">DELETE</button>
            </div>
        `;
        savedSongsList.appendChild(songDiv);
        
        // Add event listeners
        songDiv.querySelector('.load-song-btn').addEventListener('click', () => {
            displayChordChart(song);
            closeSavedSongs();
        });
        
        songDiv.querySelector('.delete-song-btn').addEventListener('click', () => {
            removeSavedSong(index);
        });
    });
}

// Xai API Configuration
// Xai API is called via server proxy (/api/generate-chord-chart-xai) to avoid CORS

// Spotify API Configuration (optional)
let spotifyConfig = {
    clientId: null,
    clientSecret: null,
    accessToken: null,
    tokenExpiry: null
};

// Cache for AI-generated results
const aiCache = new Map();

// User preferences (model, dark mode, transpose)
const USER_PREFS_KEY = 'beethovan_ai_prefs';
function loadUserPrefs() {
    try {
        const s = localStorage.getItem(USER_PREFS_KEY);
        return s ? JSON.parse(s) : {};
    } catch (e) { return {}; }
}
function saveUserPrefs(prefs) {
    const current = loadUserPrefs();
    localStorage.setItem(USER_PREFS_KEY, JSON.stringify({ ...current, ...prefs }));
}

// Load Spotify config from localStorage (if exists)
function loadApiConfig() {
    const saved = localStorage.getItem('beethovan_ai_api_config');
    if (saved) {
        try {
            const config = JSON.parse(saved);
            spotifyConfig = config.spotifyConfig || spotifyConfig;
        } catch (e) {
            // Ignore parse errors
        }
    }
}

// Save Spotify config to localStorage
function saveApiConfig() {
    localStorage.setItem('beethovan_ai_api_config', JSON.stringify({
        spotifyConfig: spotifyConfig
    }));
}

// Get Spotify Access Token
async function getSpotifyToken() {
    if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) {
        return null;
    }

    // Check if we have a valid token
    if (spotifyConfig.accessToken && spotifyConfig.tokenExpiry && Date.now() < spotifyConfig.tokenExpiry) {
        return spotifyConfig.accessToken;
    }

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa(spotifyConfig.clientId + ':' + spotifyConfig.clientSecret)
            },
            body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
            throw new Error('Spotify authentication failed');
        }

        const data = await response.json();
        spotifyConfig.accessToken = data.access_token;
        spotifyConfig.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // 1 minute buffer
        return spotifyConfig.accessToken;
    } catch (error) {
        console.error('Spotify token error:', error);
        return null;
    }
}

// Search Spotify for songs
async function searchSpotify(query) {
    const token = await getSpotifyToken();
    if (!token) {
        return null;
    }

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error('Spotify search failed');
        }

        const data = await response.json();
        if (data.tracks && data.tracks.items && data.tracks.items.length > 0) {
            const track = data.tracks.items[0];
            return {
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                spotifyId: track.id
            };
        }
        return null;
    } catch (error) {
        console.error('Spotify search error:', error);
        return null;
    }
}

// Get Spotify audio features (BPM, key) for a track - improves AI chord accuracy
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
async function getSpotifyAudioFeatures(spotifyId) {
    const token = await getSpotifyToken();
    if (!token || !spotifyId) return null;
    try {
        const res = await fetch(`https://api.spotify.com/v1/audio-features/${spotifyId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const parts = [];
        if (typeof data.tempo === 'number' && data.tempo > 0) {
            parts.push(`${Math.round(data.tempo)} BPM`);
        }
        if (typeof data.key === 'number' && data.key >= 0 && data.key <= 11) {
            const keyName = KEY_NAMES[data.key];
            const mode = data.mode === 0 ? 'minor' : 'major';
            parts.push(`key ${keyName} ${mode}`);
        }
        return parts.length ? parts.join(', ') : null;
    } catch (e) {
        console.warn('Spotify audio features:', e);
        return null;
    }
}

// AI chord generation - uses unified /api/generate-chord-chart (Xai or Groq)
async function generateChordChartWithAI(songQuery, spotifyId = null, spotifyMetadata = null) {
    const cacheKey = songQuery.toLowerCase().trim();
    const model = loadUserPrefs().model || 'xai';
    const cacheVal = aiCache.get(cacheKey);
    if (cacheVal && (!model || (cacheVal.model || 'xai') === model)) {
        return typeof cacheVal === 'object' && cacheVal.song ? cacheVal : { song: cacheVal, source: 'ai' };
    }

    if (!CAN_USE_SERVER) {
        throw new Error('AI chord charts require the app server. Open http://localhost:3001');
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        const response = await fetch((API_BASE || '') + '/api/generate-chord-chart', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songQuery, model, spotifyId, spotifyMetadata })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err.details || err.error || response.statusText;
            console.error('Chord API error:', response.status, msg);
            throw new Error(msg || `API error: ${response.status}`);
        }

        const { song: songData, source, model: usedModel } = await response.json();
        if (!songData || !songData.title || !songData.progressions || !Array.isArray(songData.progressions)) {
            throw new Error('Invalid response structure - missing title or progressions');
        }

        aiCache.set(cacheKey, { song: songData, source: source || 'ai', model: usedModel });
        return { song: songData, source: source || 'ai', model: usedModel };
    } catch (error) {
        console.error('AI chord Error:', error);
        if (error.name === 'AbortError') {
            throw new Error('Request timed out (60s). The AI may be slow—try again.');
        }
        const msg = (error?.message || String(error)).toLowerCase();
        if (msg.includes('fetch failed') || msg.includes('failed to fetch') || msg.includes('network') || msg.includes('connection')) {
            throw new Error('Cannot reach server. Is it running? Start with: cd server && node index.js — then open http://localhost:3001');
        }
        throw error;
    }
}


// DOM Elements
const songInput = document.getElementById('songInput');
const searchBtn = document.getElementById('searchBtn');
const resultsContainer = document.getElementById('results');

// Last search query (for Regenerate and Try again)
let lastSearchQuery = '';

// Search functionality - uses Xai API
async function searchSong(regenerate = false) {
    if (!resultsContainer) return;
    const query = songInput.value.trim();
    
    if (!query && !lastSearchQuery) {
        resultsContainer.innerHTML = '<div class="welcome-message"><p style="color: var(--bauhaus-red);">Please enter a song name to search.</p></div>';
        return;
    }
    const searchQuery = query || lastSearchQuery;

    if (regenerate) {
        aiCache.delete(searchQuery.toLowerCase().trim());
    }

    lastSearchQuery = searchQuery;
    if (!query) songInput.value = searchQuery;

    resultsContainer.innerHTML = '<div class="loading">SEARCHING…</div>';

    let finalQuery = searchQuery;
    let spotifyId = null;
    let spotifyMetadata = null;
    if (!regenerate && spotifyConfig.clientId && spotifyConfig.clientSecret) {
        resultsContainer.innerHTML = '<div class="loading">SEARCHING SPOTIFY</div>';
        const spotifyResult = await searchSpotify(searchQuery);
        if (spotifyResult) {
            finalQuery = `${spotifyResult.title} ${spotifyResult.artist}`;
            spotifyId = spotifyResult.spotifyId || null;
            if (spotifyId) {
                spotifyMetadata = await getSpotifyAudioFeatures(spotifyId);
            }
        }
    }

    resultsContainer.innerHTML = '<div class="loading">GENERATING WITH AI</div>';
    await new Promise(r => setTimeout(r, 100));
    const slowMsg = setTimeout(() => {
        if (resultsContainer.querySelector('.loading')) {
            resultsContainer.innerHTML = '<div class="loading">Still generating… (AI can take 15–30s)</div>';
        }
    }, 8000);

    try {
        const result = await generateChordChartWithAI(finalQuery, spotifyId, spotifyMetadata);
        clearTimeout(slowMsg);
        
        if (result && result.song && result.song.progressions && result.song.progressions.length > 0) {
            displayChordChart(result.song);
            return;
        } else {
            clearTimeout(slowMsg);
            console.error('API returned null for query:', finalQuery);
            showError(searchQuery, 'API returned no results. Check console for details.');
            return;
        }
    } catch (error) {
        clearTimeout(slowMsg);
        console.error('AI generation failed:', error);
        const msg = error?.message || String(error);
        showError(searchQuery, msg);
        return;
    }
}

// Transpose chord by semitones (C, C#, D... B = 0..11; handles m, 7, dim, /bass, etc.)
const ROOT_TO_SEMI = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const SEMI_TO_ROOT = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function transposeChord(chordStr, semitones) {
    if (!chordStr || semitones === 0) return chordStr;
    // Slash chord: e.g. C/E -> transpose both root and bass
    const slashIdx = chordStr.indexOf('/');
    if (slashIdx !== -1) {
        const main = transposeChord(chordStr.slice(0, slashIdx), semitones);
        const bass = transposeChord(chordStr.slice(slashIdx + 1), semitones);
        return main + '/' + bass;
    }
    const match = chordStr.match(/^([A-G][#b]?)(.*)$/i);
    if (!match) return chordStr;
    const root = match[1];
    const suffix = match[2] || '';
    const n = ROOT_TO_SEMI[root];
    if (n === undefined) return chordStr;
    const newN = (n + semitones + 12) % 12;
    return SEMI_TO_ROOT[newN] + suffix;
}

// Current chart state for re-rendering on transpose
let currentDisplayedSong = null;
let currentTransposeSemitones = 0;

// Display chord chart
function displayChordChart(song, transposeSemitones = null) {
    if (!song || !song.progressions || !Array.isArray(song.progressions) || song.progressions.length === 0) {
        showError(lastSearchQuery || song?.title || 'Unknown', 'No chord data to display.');
        return;
    }
    currentDisplayedSong = song;
    // Auto-transpose: use saved preference if not explicitly passed
    if (transposeSemitones === null || transposeSemitones === undefined) {
        const prefs = loadUserPrefs();
        transposeSemitones = typeof prefs.transposeSemitones === 'number' ? prefs.transposeSemitones : 0;
    }
    currentTransposeSemitones = transposeSemitones;

    const displayTitle = song.titleEn ? `${song.title} (${song.titleEn})` : song.title;
    const sourceBadge = '<span class="ai-badge">AI-generated — verify with tabs</span>';
    
    const isSaved = savedSongs.some(s => 
        s.title === song.title && s.artist === song.artist
    );
    
    const keyLabel = transposeSemitones === 0 ? 'Original' : (transposeSemitones > 0 ? '+' + transposeSemitones : transposeSemitones);
    
    let html = `
        <div class="chord-chart" id="currentChordChart">
            ${sourceBadge}
            <div class="chart-header">
                <div>
                    <h2 class="song-title">${displayTitle}</h2>
                    <p class="song-artist">${song.artist || 'Unknown Artist'}</p>
                </div>
                <div class="chart-header-actions">
                    <div class="transpose-control">
                        <span class="transpose-label">KEY</span>
                        <button type="button" id="transposeDown" class="transpose-btn" title="Transpose down">−</button>
                        <span id="transposeValue" class="transpose-value">${keyLabel}</span>
                        <button type="button" id="transposeUp" class="transpose-btn" title="Transpose up">+</button>
                    </div>
                    <button id="reportBtn" class="save-song-btn report-btn" type="button" title="Report inaccurate chords">⚠ REPORT</button>
                    <button id="shareChartBtn" class="save-song-btn copy-btn" type="button" title="Copy share link">🔗 SHARE</button>
                    <button id="exportPdfBtn" class="save-song-btn copy-btn" type="button" title="Export as PDF">📄 PDF</button>
                    <button id="copyChartBtn" class="save-song-btn copy-btn" type="button" title="Copy chord chart">📋 COPY</button>
                    <button id="regenerateBtn" class="save-song-btn regenerate-btn" type="button" title="Generate again">🔄 REGENERATE</button>
                    <button id="saveSongBtn" class="save-song-btn" ${isSaved ? 'disabled' : ''}>
                        ${isSaved ? '✓ SAVED' : '💾 SAVE'}
                    </button>
                </div>
            </div>
    `;

    // Display progressions (chord-over-lyric style like Ultimate Guitar)
    song.progressions.forEach((progression, index) => {
        const sectionLabel = progression.label ? `[${progression.label}]` : '';
        html += `<div class="chord-progression"><div class="progression-label">${sectionLabel}</div>`;

        if (progression.parts && progression.parts.length > 0) {
            // Chord-over-lyric layout (chord above lyric)
            html += '<div class="chord-lyric-block">';
            progression.parts.forEach((part) => {
                const displayChord = transposeChord(part.chord, transposeSemitones);
                html += `<span class="chord-lyric-pair"><span class="chord-above">${displayChord}</span><span class="lyric-below">${escapeHtml(part.lyric || '')}</span></span>`;
            });
            html += '</div>';
        } else {
            // Chords only: chord line (blue, above blank line) — no grid boxes
            const chords = (progression.chords || []).map(c => transposeChord(c, transposeSemitones));
            if (chords.length > 0) {
                html += '<div class="chord-line-block">';
                html += '<div class="chord-line">' + chords.map(c => `<span class="chord-inline">${c}</span>`).join(' ') + '</div>';
                html += '<div class="lyric-line lyric-empty"></div>';
                html += '</div>';
            }
        }
        html += '</div>';
    });

    html += `</div>`;

    resultsContainer.innerHTML = html;

    // Add save button handler
    const saveBtn = document.getElementById('saveSongBtn');
    if (saveBtn && !isSaved) {
        saveBtn.addEventListener('click', async () => {
            await saveSong(song);
            if (savedSongs.some(s => s.title === song.title && (s.artist || '') === (song.artist || ''))) {
                saveBtn.textContent = '✓ SAVED';
                saveBtn.disabled = true;
            }
        });
    }

    // Transpose buttons (save preference when user changes key)
    document.getElementById('transposeDown').addEventListener('click', () => {
        const newSemitones = currentTransposeSemitones - 1;
        saveUserPrefs({ transposeSemitones: newSemitones });
        displayChordChart(currentDisplayedSong, newSemitones);
    });
    document.getElementById('transposeUp').addEventListener('click', () => {
        const newSemitones = currentTransposeSemitones + 1;
        saveUserPrefs({ transposeSemitones: newSemitones });
        displayChordChart(currentDisplayedSong, newSemitones);
    });

    // Report inaccurate
    const reportBtn = document.getElementById('reportBtn');
    if (reportBtn) {
        reportBtn.addEventListener('click', () => openReportModal(song));
    }

    // Share link (copy URL with encoded chart)
    const shareChartBtn = document.getElementById('shareChartBtn');
    if (shareChartBtn) {
        shareChartBtn.addEventListener('click', () => {
            const payload = { song, transposeSemitones: currentTransposeSemitones };
            const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_');
            const url = window.location.origin + window.location.pathname + '?share=' + encoded;
            navigator.clipboard.writeText(url).then(() => {
                const orig = shareChartBtn.textContent;
                shareChartBtn.textContent = '✓ COPIED';
                setTimeout(() => { shareChartBtn.textContent = orig; }, 1500);
            }).catch(() => alert('Copy failed'));
        });
    }

    // Export PDF
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    if (exportPdfBtn && typeof html2pdf !== 'undefined') {
        exportPdfBtn.addEventListener('click', () => {
            const el = document.getElementById('currentChordChart');
            if (!el) return;
            const opt = { margin: 10, filename: `${(song.title || 'chart').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
            html2pdf().set(opt).from(el).save().catch(() => alert('PDF export failed'));
        });
    }

    // Copy chord chart (with current transpose)
    document.getElementById('copyChartBtn').addEventListener('click', () => {
        const lines = [
            `${song.title} — ${song.artist || 'Unknown Artist'}`,
            currentTransposeSemitones !== 0 ? `Key: ${currentTransposeSemitones > 0 ? '+' : ''}${currentTransposeSemitones}` : '',
            ''
        ];
        song.progressions.forEach(p => {
            lines.push(p.label ? `[${p.label}]` : '');
            if (p.parts && p.parts.length > 0) {
                const chordLine = p.parts.map(pt => transposeChord(pt.chord, currentTransposeSemitones)).join(' ');
                const lyricLine = p.parts.map(pt => pt.lyric || '').join('');
                lines.push(chordLine);
                lines.push(lyricLine);
            } else {
                const chords = (p.chords || []).map(c => transposeChord(c, currentTransposeSemitones));
                lines.push(chords.join('  '));
            }
            lines.push('');
        });
        const text = lines.filter(Boolean).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('copyChartBtn');
            const orig = btn.textContent;
            btn.textContent = '✓ COPIED';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        }).catch(() => alert('Copy failed'));
    });

    const regenBtn = document.getElementById('regenerateBtn');
    if (regenBtn) {
        regenBtn.addEventListener('click', () => {
            resultsContainer.innerHTML = '<div class="loading">REGENERATING</div>';
            searchSong(true);
        });
    }
}

// Show error message
function showError(query, errorDetails = null) {
    let errorMessage = 'Please try again.';
    if (errorDetails) {
        errorMessage = `Error: ${errorDetails}`;
    }
    
    const errorHtml = `
        <div class="error-message">
            <h3>SONG NOT FOUND</h3>
            <p>We couldn't generate a chord chart for "${query}".</p>
            <p style="margin-top: 1rem; color: var(--text-secondary);">
                ${errorMessage}
            </p>
            <p style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">
                Check the browser console (F12) for more details.
            </p>
            <button id="tryAgainBtn" class="save-song-btn" style="margin-top: 1rem;">🔄 TRY AGAIN</button>
        </div>
    `;
    
    resultsContainer.innerHTML = errorHtml;
    
    const tryAgainBtn = document.getElementById('tryAgainBtn');
    if (tryAgainBtn) {
        tryAgainBtn.addEventListener('click', () => {
            songInput.value = lastSearchQuery;
            searchSong();
        });
    }
}

// Show welcome message
function showWelcome() {
    if (!resultsContainer) return;
    const fileNote = typeof window !== 'undefined' && window.location?.protocol === 'file:'
        ? '<p style="margin-top: 1rem; color: var(--bauhaus-red); font-weight: 600;">⚠ Run the server and open <a href="http://localhost:3001">http://localhost:3001</a> for search to work.</p>'
        : '';
    resultsContainer.innerHTML = `
        <div class="welcome-message">
            <h2>WELCOME</h2>
            <p>Search for ANY song in the world!</p>
            ${fileNote}
            <p style="margin-top: 1rem; color: var(--bauhaus-blue); font-weight: 700;">💡 Register to save up to 10 songs; $1 for unlimited.</p>
        </div>
    `;
}

// Settings Modal Functions

// --- Auth ---
async function loadUser() {
    const token = getToken();
    if (!token) {
        currentUser = null;
        return;
    }
    try {
        const res = await fetch(API_BASE + '/api/me', { headers: getAuthHeader() });
        if (res.ok) {
            currentUser = await res.json();
            return;
        }
    } catch (e) {
        console.error('Auth check failed', e);
    }
    currentUser = null;
    localStorage.removeItem('beethovan_ai_token');
}

function updateHeaderAuth() {
    const authStatus = document.getElementById('authStatus');
    const loginBtn = document.getElementById('loginBtn');
    const registerBtn = document.getElementById('registerBtn');
    const upgradeBtn = document.getElementById('upgradeBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    if (!currentUser) {
        if (authStatus) authStatus.textContent = '';
        if (loginBtn) { loginBtn.style.display = 'inline-block'; }
        if (registerBtn) { registerBtn.style.display = 'inline-block'; }
        if (upgradeBtn) { upgradeBtn.style.display = 'none'; }
        if (logoutBtn) { logoutBtn.style.display = 'none'; }
    } else {
        const limitText = currentUser.tier === 'unlimited'
            ? 'Unlimited'
            : `${currentUser.savedCount || savedSongs.length}/10`;
        if (authStatus) authStatus.textContent = `${currentUser.email} (${limitText})`;
        if (loginBtn) { loginBtn.style.display = 'none'; }
        if (registerBtn) { registerBtn.style.display = 'none'; }
        if (upgradeBtn) {
            upgradeBtn.style.display = currentUser.tier === 'unlimited' ? 'none' : 'inline-block';
        }
        if (logoutBtn) { logoutBtn.style.display = 'inline-block'; }
    }
}

function openLogin() {
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('loginError').style.display = 'none';
}
function closeLogin() {
    document.getElementById('loginModal').style.display = 'none';
}
function openRegister() {
    document.getElementById('registerModal').style.display = 'flex';
    document.getElementById('registerError').style.display = 'none';
}
function closeRegister() {
    document.getElementById('registerModal').style.display = 'none';
}

async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    if (!email || !password) {
        errEl.textContent = 'Email and password required';
        errEl.style.display = 'block';
        return;
    }
    try {
        const res = await fetch(API_BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            localStorage.setItem('beethovan_ai_token', data.token);
            currentUser = data.user;
            await loadSavedSongs();
            updateHeaderAuth();
            closeLogin();
            renderSavedSongs();
            return;
        }
        errEl.textContent = data.error || 'Login failed';
        errEl.style.display = 'block';
    } catch (e) {
        errEl.textContent = 'Network error. Is the server running?';
        errEl.style.display = 'block';
    }
}

async function doRegister() {
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const errEl = document.getElementById('registerError');
    if (!email || !password) {
        errEl.textContent = 'Email and password required';
        errEl.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        errEl.textContent = 'Password must be at least 6 characters';
        errEl.style.display = 'block';
        return;
    }
    try {
        const res = await fetch(API_BASE + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            localStorage.setItem('beethovan_ai_token', data.token);
            currentUser = data.user;
            await loadSavedSongs();
            updateHeaderAuth();
            closeRegister();
            renderSavedSongs();
            return;
        }
        errEl.textContent = data.error || 'Registration failed';
        errEl.style.display = 'block';
    } catch (e) {
        errEl.textContent = 'Network error. Is the server running?';
        errEl.style.display = 'block';
    }
}

function doLogout() {
    currentUser = null;
    localStorage.removeItem('beethovan_ai_token');
    savedSongs = [];
    loadSavedSongs(); // reload from localStorage if any
    updateHeaderAuth();
    renderSavedSongs();
}

function openUpgrade() {
    if (!currentUser) {
        openLogin();
        return;
    }
    if (currentUser.tier === 'unlimited') {
        alert('You already have unlimited saves!');
        return;
    }
    const modal = document.getElementById('upgradeModal');
    const errEl = document.getElementById('upgradeError');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    modal.style.display = 'flex';
}

function closeUpgrade() {
    document.getElementById('upgradeModal').style.display = 'none';
}

async function doCheckout(plan) {
    const errEl = document.getElementById('upgradeError');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    try {
        const res = await fetch(API_BASE + '/api/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
            body: JSON.stringify({ plan })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) {
            window.location.href = data.url;
            return;
        }
        if (errEl) {
            errEl.textContent = data.error || 'Payment not configured. Set up Stripe on the server.';
            errEl.style.display = 'block';
        } else {
            alert(data.error || 'Payment not configured. Set up Stripe on the server.');
        }
    } catch (e) {
        if (errEl) {
            errEl.textContent = 'Network error. Make sure the server is running.';
            errEl.style.display = 'block';
        } else {
            alert('Network error. Make sure the server is running.');
        }
    }
}

function doUpgrade() {
    openUpgrade();
}

// Report Inaccurate Modal
function openReportModal(song) {
    if (!song) return;
    window._reportSong = song;
    document.getElementById('reportNote').value = '';
    document.getElementById('reportCorrected').value = '';
    document.getElementById('reportError').style.display = 'none';
    document.getElementById('reportModal').style.display = 'flex';
}

function closeReport() {
    document.getElementById('reportModal').style.display = 'none';
    window._reportSong = null;
}

async function doReportSubmit() {
    const song = window._reportSong;
    const errEl = document.getElementById('reportError');
    const note = document.getElementById('reportNote').value.trim();
    const correctedRaw = document.getElementById('reportCorrected').value.trim();

    if (!note) {
        errEl.textContent = 'Please describe what\'s wrong.';
        errEl.style.display = 'block';
        return;
    }

    let correctedProgressions = null;
    if (correctedRaw) {
        try {
            const parsed = JSON.parse(correctedRaw);
            correctedProgressions = Array.isArray(parsed) ? parsed : (parsed.progressions || null);
        } catch (e) {
            errEl.textContent = 'Invalid JSON in correct chords.';
            errEl.style.display = 'block';
            return;
        }
    }

    const payload = {
        title: song.title,
        artist: song.artist || 'Unknown',
        originalProgressions: song.progressions || [],
        note
    };
    if (correctedProgressions) payload.correctedProgressions = correctedProgressions;

    try {
        const res = await fetch(API_BASE + '/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            closeReport();
            alert('Thank you for your feedback!');
            return;
        }
        errEl.textContent = data.error || 'Failed to send report';
        errEl.style.display = 'block';
    } catch (e) {
        errEl.textContent = 'Network error. Is the server running?';
        errEl.style.display = 'block';
    }
}

// Saved Songs Modal Functions
async function openSavedSongs() {
    const modal = document.getElementById('savedSongsModal');
    modal.style.display = 'flex';
    if (!currentUser) {
        const list = document.getElementById('savedSongsList');
        if (list) {
            list.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 1rem;">Register or log in to save up to 10 songs for free. $1/month or $10/year for unlimited.</p>';
            const wrap = document.createElement('div');
            wrap.style.textAlign = 'center';
            wrap.innerHTML = '<button class="save-btn" id="savedSongsRegisterBtn" style="margin: 0.5rem;">REGISTER</button> <button class="cancel-btn" id="savedSongsLoginBtn">LOG IN</button>';
            list.appendChild(wrap);
            document.getElementById('savedSongsRegisterBtn').addEventListener('click', () => { closeSavedSongs(); openRegister(); });
            document.getElementById('savedSongsLoginBtn').addEventListener('click', () => { closeSavedSongs(); openLogin(); });
        }
    } else {
        await loadSavedSongs();
        if (currentUser) currentUser.savedCount = savedSongs.length;
        updateHeaderAuth();
        renderSavedSongs();
    }
}

function closeSavedSongs() {
    document.getElementById('savedSongsModal').style.display = 'none';
}

// Event Listeners
if (searchBtn) searchBtn.addEventListener('click', () => searchSong());

songInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        searchSong();
    }
});

// Clear results when input is cleared
songInput.addEventListener('input', (e) => {
    if (e.target.value.trim() === '') {
        showWelcome();
    }
});


// Saved Songs modal events
document.getElementById('savedSongsBtn').addEventListener('click', openSavedSongs);
document.getElementById('closeSavedSongs').addEventListener('click', closeSavedSongs);
const savedSongsFilterEl = document.getElementById('savedSongsFilter');
if (savedSongsFilterEl) {
    savedSongsFilterEl.addEventListener('input', (e) => renderSavedSongs(e.target.value));
}

// Auth modal events
document.getElementById('loginBtn').addEventListener('click', openLogin);
document.getElementById('registerBtn').addEventListener('click', openRegister);
document.getElementById('closeLogin').addEventListener('click', closeLogin);
document.getElementById('closeRegister').addEventListener('click', closeRegister);
document.getElementById('loginSubmitBtn').addEventListener('click', doLogin);
document.getElementById('registerSubmitBtn').addEventListener('click', doRegister);
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('upgradeBtn').addEventListener('click', doUpgrade);
document.getElementById('closeUpgrade').addEventListener('click', closeUpgrade);
document.querySelectorAll('.upgrade-plan-btn').forEach(btn => {
    btn.addEventListener('click', () => doCheckout(btn.dataset.plan));
});

// Report modal
document.getElementById('closeReport').addEventListener('click', closeReport);
document.getElementById('reportSubmitBtn').addEventListener('click', doReportSubmit);

// Model selector
const modelSelect = document.getElementById('modelSelect');
if (modelSelect) {
    const prefs = loadUserPrefs();
    if (prefs.model) modelSelect.value = prefs.model;
    modelSelect.addEventListener('change', () => saveUserPrefs({ model: modelSelect.value }));
}

// Dark mode toggle
const darkModeBtn = document.getElementById('darkModeBtn');
if (darkModeBtn) {
    const prefs = loadUserPrefs();
    const isDark = prefs.darkMode === true;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    darkModeBtn.textContent = isDark ? '☀️' : '🌙';
    darkModeBtn.title = isDark ? 'Light mode' : 'Dark mode';
    darkModeBtn.addEventListener('click', () => {
        const nowDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const nextDark = !nowDark;
        document.documentElement.setAttribute('data-theme', nextDark ? 'dark' : 'light');
        darkModeBtn.textContent = nextDark ? '☀️' : '🌙';
        darkModeBtn.title = nextDark ? 'Light mode' : 'Dark mode';
        saveUserPrefs({ darkMode: nextDark });
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
        history.replaceState({}, '', window.location.pathname);
        await loadUser();
        if (currentUser) {
            updateHeaderAuth();
            alert("Thank you for your payment! You now have unlimited saved songs. If you don't see it yet, refresh the page.");
        }
    }
    await loadUser();
    await loadSavedSongs();
    updateHeaderAuth();
    loadApiConfig();
    const shareEncoded = params.get('share');
    if (shareEncoded) {
        try {
            const b64 = shareEncoded.replace(/-/g, '+').replace(/_/g, '/');
            const json = decodeURIComponent(escape(atob(b64)));
            const { song, transposeSemitones } = JSON.parse(json);
            if (song && song.progressions) {
                history.replaceState({}, '', window.location.pathname);
                displayChordChart(song, transposeSemitones ?? 0);
                return;
            }
        } catch (e) {
            console.warn('Invalid share link:', e);
        }
    }
    showWelcome();
});
