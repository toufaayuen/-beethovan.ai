(function () {
  const API_BASE = typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '';

  const REMIX_GENRES = [
    'Jazz', 'Pop', 'Rock', 'Hip-Hop', 'Classical', 'K-Pop', 'R&B', 'Country',
    'Electronic', 'Latin', 'Folk', 'Soul', 'Reggae', 'Metal', 'Ambient', 'Blues',
  ];

  let allSongs = [];
  let currentSong = null;
  let loadedLeadSheet = '';
  let loadedImprovTips = [];
  let lastRemix = null;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    localStorage.setItem('beethovan_realbook_theme', theme);
    const btn = $('rbThemeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function initTheme() {
    const saved = localStorage.getItem('beethovan_realbook_theme')
      || (localStorage.getItem('beethovan_ai_prefs') && (() => {
        try {
          const p = JSON.parse(localStorage.getItem('beethovan_ai_prefs'));
          return p.darkMode ? 'dark' : 'light';
        } catch (_) { return null; }
      })());
    applyTheme(saved === 'dark' ? 'dark' : 'light');
  }

  $('rbThemeToggle')?.addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(t);
  });

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  function getFilteredSongs() {
    const q = ($('rbSearch')?.value || '').toLowerCase().trim();
    const g = ($('rbGenre')?.value || '').trim();
    return allSongs.filter((s) => {
      const matchG = !g || s.genre === g;
      const hay = `${s.title} ${s.artist}`.toLowerCase();
      const matchQ = !q || hay.includes(q);
      return matchG && matchQ;
    });
  }

  function renderTable() {
    const tbody = $('rbTbody');
    const countEl = $('rbCount');
    if (!tbody) return;
    const rows = getFilteredSongs();
    if (countEl) countEl.textContent = `${rows.length} tune${rows.length === 1 ? '' : 's'} shown · ${allSongs.length} total in catalog`;

    tbody.innerHTML = rows.map((s) => `
      <tr data-id="${escapeHtml(s.id)}">
        <td><span class="rb-title">${escapeHtml(s.title)}</span></td>
        <td class="rb-meta">${escapeHtml(s.artist)}</td>
        <td><span class="rb-genre-pill">${escapeHtml(s.genre)}</span></td>
        <td class="rb-meta">${escapeHtml(String(s.year ?? '—'))}</td>
        <td><button type="button" class="rb-btn secondary rb-open" data-id="${escapeHtml(s.id)}">Open</button></td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="rb-loading">No matches.</td></tr>';

    tbody.querySelectorAll('.rb-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (id) window.location.hash = id;
      });
    });
  }

  function fillGenreSelect(genres) {
    const sel = $('rbGenre');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All genres</option>'
      + genres.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    if (genres.includes(cur)) sel.value = cur;
  }

  function fillRemixSelect() {
    const sel = $('rbRemixTarget');
    if (!sel) return;
    sel.innerHTML = REMIX_GENRES.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  }

  async function loadCatalog() {
    const tbody = $('rbTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="rb-loading">Loading catalog…</td></tr>';
    try {
      const res = await fetch(API_BASE + '/api/realbook/catalog');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Catalog failed');
      allSongs = data.songs || [];
      fillGenreSelect(data.genres || []);
      renderTable();
    } catch (e) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="rb-msg error">${escapeHtml(e.message)}</td></tr>`;
      }
    }
  }

  function showList() {
    $('rbListView').style.display = 'block';
    $('rbDetailView').style.display = 'none';
    window.location.hash = '';
    currentSong = null;
  }

  function showDetail(song, prefill) {
    currentSong = song;
    loadedLeadSheet = '';
    loadedImprovTips = [];
    lastRemix = null;
    $('rbListView').style.display = 'none';
    $('rbDetailView').style.display = 'block';
    $('rbDetailTitle').textContent = song.title;
    $('rbDetailMeta').textContent = `${song.artist} · ${song.genre} · ${song.year ?? '—'}`;
    $('rbLeadSheet').textContent = '— Click “Load AI lead sheet” —';
    $('rbImprovList').innerHTML = '';
    $('rbExportPdf').disabled = true;
    $('rbRemixBtn').disabled = true;
    $('rbRemixColumns').style.display = 'none';
    $('rbRemixOriginal').textContent = '';
    $('rbRemixNew').textContent = '';
    $('rbWhy').textContent = '';
    $('rbVariations').innerHTML = '';

    if (prefill && typeof prefill.leadSheet === 'string' && prefill.leadSheet.trim()) {
      loadedLeadSheet = prefill.leadSheet;
      loadedImprovTips = Array.isArray(prefill.improvTips) ? prefill.improvTips : [];
      $('rbLeadSheet').textContent = loadedLeadSheet;
      $('rbImprovList').innerHTML = loadedImprovTips.length
        ? loadedImprovTips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
        : '<li>—</li>';
      $('rbExportPdf').disabled = false;
      $('rbRemixBtn').disabled = false;
    }

    const rt = $('rbRemixTarget');
    if (rt && song.genre) {
      const opts = [...rt.options].map((o) => o.value);
      if (opts.includes(song.genre)) {
        const firstOther = REMIX_GENRES.find((g) => g !== song.genre);
        if (firstOther) rt.value = firstOther;
      }
    }
  }

  function routeFromHash() {
    const h = (window.location.hash || '').replace(/^#/, '').trim();
    if (!h) {
      showList();
      return;
    }
    const song = allSongs.find((s) => s.id === h);
    if (song) {
      let prefill = null;
      try {
        const raw = sessionStorage.getItem('rb_prefill');
        if (raw) {
          const o = JSON.parse(raw);
          if (o && o.id === song.id) {
            prefill = { leadSheet: o.leadSheet, improvTips: o.improvTips };
            sessionStorage.removeItem('rb_prefill');
          }
        }
      } catch (_) {}
      showDetail(song, prefill);
    } else {
      $('rbListView').style.display = 'block';
      $('rbDetailView').style.display = 'none';
    }
  }

  $('rbSearch')?.addEventListener('input', renderTable);
  $('rbGenre')?.addEventListener('change', renderTable);
  $('rbClearFilters')?.addEventListener('click', () => {
    if ($('rbSearch')) $('rbSearch').value = '';
    if ($('rbGenre')) $('rbGenre').value = '';
    renderTable();
  });
  $('rbBack')?.addEventListener('click', showList);
  window.addEventListener('hashchange', routeFromHash);

  $('rbLoadSheet')?.addEventListener('click', async () => {
    if (!currentSong) return;
    const btn = $('rbLoadSheet');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    $('rbLeadSheet').textContent = '…';
    try {
      const out = await apiPost('/api/chords/realbook-lead-sheet', {
        title: currentSong.title,
        artist: currentSong.artist,
        genre: currentSong.genre,
      });
      loadedLeadSheet = out.leadSheet || '';
      loadedImprovTips = out.improvTips || [];
      $('rbLeadSheet').textContent = loadedLeadSheet || '(empty)';
      const ul = $('rbImprovList');
      ul.innerHTML = (loadedImprovTips.length ? loadedImprovTips : ['—']).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
      $('rbExportPdf').disabled = !loadedLeadSheet;
      $('rbRemixBtn').disabled = !loadedLeadSheet;
    } catch (e) {
      $('rbLeadSheet').textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load AI lead sheet';
    }
  });

  $('rbRemixBtn')?.addEventListener('click', async () => {
    if (!currentSong || !loadedLeadSheet) return;
    const btn = $('rbRemixBtn');
    const target = $('rbRemixTarget')?.value;
    if (!target) return;
    btn.disabled = true;
    btn.textContent = 'Remixing…';
    $('rbRemixColumns').style.display = 'grid';
    $('rbRemixOriginal').textContent = loadedLeadSheet;
    $('rbRemixNew').textContent = '…';
    try {
      const out = await apiPost('/api/chords/realbook-remix', {
        title: currentSong.title,
        artist: currentSong.artist,
        originalGenre: currentSong.genre,
        targetGenre: target,
        originalLeadSheet: loadedLeadSheet,
      });
      lastRemix = out;
      $('rbRemixNew').textContent = out.remixedLeadSheet || '';
      $('rbWhy').textContent = out.whyItWorks || '';
      const v = $('rbVariations');
      v.innerHTML = (out.variations && out.variations.length)
        ? out.variations.map((x) => `<li>${escapeHtml(x)}</li>`).join('')
        : '';
    } catch (e) {
      $('rbRemixNew').textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Regenerate chords';
    }
  });

  function exportPdf() {
    if (!window.jspdf?.jsPDF) {
      alert('jsPDF failed to load. Check your network or refresh.');
      return;
    }
    if (!currentSong || !loadedLeadSheet) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const left = 48;
    let y = 52;
    const maxW = 515;
    const lineH = 13;

    doc.setFont('times', 'bold');
    doc.setFontSize(18);
    doc.text(currentSong.title, left, y);
    y += 24;
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    doc.text(`${currentSong.artist}  ·  ${currentSong.genre}  ·  ${currentSong.year ?? '—'}`, left, y);
    y += 28;
    doc.setFontSize(10);
    doc.text('Lead sheet', left, y);
    y += 16;

    const body = doc.splitTextToSize(loadedLeadSheet, maxW);
    for (let i = 0; i < body.length; i += 1) {
      if (y > 720) {
        doc.addPage();
        y = 48;
      }
      doc.text(body[i], left, y);
      y += lineH;
    }

    if (loadedImprovTips.length) {
      y += 10;
      if (y > 680) {
        doc.addPage();
        y = 48;
      }
      doc.setFont('times', 'bold');
      doc.text('Improv tips', left, y);
      y += 16;
      doc.setFont('times', 'normal');
      for (const t of loadedImprovTips) {
        const lines = doc.splitTextToSize(`• ${t}`, maxW - 12);
        for (const line of lines) {
          if (y > 720) {
            doc.addPage();
            y = 48;
          }
          doc.text(line, left + 8, y);
          y += lineH;
        }
      }
    }

    if (lastRemix?.remixedLeadSheet) {
      doc.addPage();
      y = 48;
      doc.setFont('times', 'bold');
      doc.text(`Remixed (${$('rbRemixTarget')?.value || 'target genre'})`, left, y);
      y += 20;
      doc.setFont('times', 'normal');
      const rem = doc.splitTextToSize(lastRemix.remixedLeadSheet, maxW);
      for (const line of rem) {
        if (y > 720) {
          doc.addPage();
          y = 48;
        }
        doc.text(line, left, y);
        y += lineH;
      }
    }

    const slug = `${currentSong.title}-${currentSong.artist}`.replace(/[^\w\-]+/g, '-').slice(0, 60);
    doc.save(`realbook-${slug}.pdf`);
  }

  $('rbExportPdf')?.addEventListener('click', exportPdf);

  $('rbAnyBtn')?.addEventListener('click', async () => {
    const q = ($('rbAnyQuery')?.value || '').trim();
    const box = $('rbAnyResult');
    if (!q) {
      box.style.display = 'block';
      box.innerHTML = '<div class="rb-msg error">Enter a song or artist.</div>';
      return;
    }
    box.style.display = 'block';
    box.innerHTML = '<div class="rb-loading">Generating Real Book chart…</div>';
    try {
      const data = await apiPost('/api/chords/realbook-search', { query: q });
      box.innerHTML = `
        <div class="rb-sheet" style="margin-bottom:0.75rem;">
          <strong>${escapeHtml(data.title)}</strong> — ${escapeHtml(data.artist)}
          <br><span class="rb-genre-pill">${escapeHtml(data.genre)}</span>
          ${data.year ? ` · ${escapeHtml(String(data.year))}` : ''}
        </div>
        <div class="rb-sheet" style="white-space:pre-wrap;">${escapeHtml(data.leadSheet)}</div>
        <ul class="rb-tips" style="margin-top:0.75rem;">${(data.improvTips || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
          <button type="button" class="rb-btn" id="rbAddToBook">Add to book (after review)</button>
          <button type="button" class="rb-btn secondary" id="rbOpenAsDetail">Open as tune page</button>
        </div>
      `;
      const payload = { ...data };
      $('rbAddToBook')?.addEventListener('click', async () => {
        try {
          await apiPost('/api/chords/realbook-add-to-book', {
            title: payload.title,
            artist: payload.artist,
            genre: payload.genre,
            year: payload.year,
            leadSheet: payload.leadSheet,
            improvTips: payload.improvTips,
          });
          await loadCatalog();
          box.insertAdjacentHTML('beforeend', '<div class="rb-msg">Saved to community extensions. Refresh the index to see it.</div>');
        } catch (e) {
          box.insertAdjacentHTML('beforeend', `<div class="rb-msg error">${escapeHtml(e.message)}</div>`);
        }
      });
      $('rbOpenAsDetail')?.addEventListener('click', () => {
        const synthetic = {
          id: `rb-temp-${Date.now()}`,
          title: data.title,
          artist: data.artist,
          genre: data.genre,
          year: data.year,
        };
        allSongs = [...allSongs, synthetic];
        try {
          sessionStorage.setItem('rb_prefill', JSON.stringify({
            id: synthetic.id,
            leadSheet: data.leadSheet,
            improvTips: data.improvTips || [],
          }));
        } catch (_) {}
        window.location.hash = synthetic.id;
      });
    } catch (e) {
      box.innerHTML = `<div class="rb-msg error">${escapeHtml(e.message)}</div>`;
    }
  });

  $('sgSubmit')?.addEventListener('click', async () => {
    const title = ($('sgTitle')?.value || '').trim();
    const msg = $('sgMsg');
    msg.innerHTML = '';
    if (!title) {
      msg.innerHTML = '<div class="rb-msg error">Title required.</div>';
      return;
    }
    try {
      const out = await apiPost('/api/chords/realbook-suggest', {
        title,
        artist: ($('sgArtist')?.value || '').trim(),
        genre: ($('sgGenre')?.value || '').trim(),
        year: $('sgYear')?.value ? parseInt($('sgYear').value, 10) : null,
        note: ($('sgNote')?.value || '').trim(),
      });
      msg.innerHTML = `
        <div class="rb-msg">${out.worthy ? '✓ Worth including (per AI).' : '○ Not recommended (per AI).'}</div>
        <p style="margin-top:0.5rem;font-size:0.95rem;">${escapeHtml(out.reason || '')}</p>
        ${out.sampleChart ? `<div class="rb-sheet" style="margin-top:0.75rem;white-space:pre-wrap;">${escapeHtml(out.sampleChart)}</div>` : ''}
      `;
    } catch (e) {
      msg.innerHTML = `<div class="rb-msg error">${escapeHtml(e.message)}</div>`;
    }
  });

  initTheme();
  fillRemixSelect();
  loadCatalog().then(() => routeFromHash());
})();
