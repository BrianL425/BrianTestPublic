const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('spotifyConnect');
const diagBtn = document.getElementById('runDiagnostics');
const diagStatus = document.getElementById('diagStatus');
const form = document.getElementById('playlistForm');
const previewBtn = document.getElementById('previewBtn');
const createBtn = document.getElementById('createBtn');
const previewEl = document.getElementById('preview');
const resultEl = document.getElementById('result');

let latestPreview = null;

function showSection(el, html) {
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function showResult(html) {
  showSection(resultEl, html);
}

function showPreview(html) {
  showSection(previewEl, html);
}

function getFormPayload() {
  return {
    playlistName: document.getElementById('playlistName').value.trim(),
    folderName: document.getElementById('folderName').value.trim(),
    description: document.getElementById('description').value.trim(),
    trackCount: Number(document.getElementById('trackCount').value),
    isPublic: document.getElementById('isPublic').checked
  };
}

function renderMatchedTrackList(items) {
  return items.map((x, i) => `${i + 1}. ${x.matched}`).join('\n');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPreviewRows(rows) {
  return `
    <ol class="preview-list">
      ${rows
        .map((row) => {
          const req = `${escapeHtml(row.requested.title)} - ${escapeHtml(row.requested.artist)}`;
          const status = row.matched
            ? `<span class="chip chip-ok">✓ Matched</span>`
            : `<span class="chip chip-miss">Missed</span>`;
          const matchedText = row.matchedName
            ? `<div class="preview-match">Spotify: ${escapeHtml(row.matchedName)}</div>`
            : '';
          return `<li>${status}<div class="preview-requested">${req}</div>${matchedText}</li>`;
        })
        .join('')}
    </ol>
  `;
}

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();

  if (data.connected) {
    const who = data.userEmail || '(email unavailable - click Reconnect Spotify)';
    statusEl.textContent = `Connected as ${who}`;
    connectBtn.disabled = false;
    connectBtn.textContent = 'Reconnect Spotify';
  } else {
    statusEl.textContent = 'Not connected';
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect Spotify';
  }
}

connectBtn.addEventListener('click', () => {
  window.location.href = '/auth/spotify';
});

diagBtn.addEventListener('click', async () => {
  diagBtn.disabled = true;
  diagStatus.textContent = 'Running Spotify API diagnostics...';

  try {
    const res = await fetch('/api/debug/spotify', { method: 'POST' });
    const data = await res.json();
    const label = res.status === 200 ? 'Diagnostics passed' : 'Diagnostics found failures';
    showResult(`<h3>${label}</h3><pre>${JSON.stringify(data, null, 2)}</pre>`);
    diagStatus.textContent = 'Diagnostics complete.';
  } catch (err) {
    showResult(`<h3>Diagnostics failed</h3><pre>${err.message}</pre>`);
    diagStatus.textContent = 'Diagnostics request failed.';
  } finally {
    diagBtn.disabled = false;
  }
});

previewBtn.addEventListener('click', async () => {
  const payload = getFormPayload();
  latestPreview = null;
  createBtn.disabled = true;

  previewBtn.disabled = true;
  previewBtn.textContent = 'Generating Preview...';

  try {
    const res = await fetch('/api/preview-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: payload.description, trackCount: payload.trackCount })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Preview failed');

    latestPreview = data;
    createBtn.disabled = false;

    showPreview(`
      <h3>Preview Ready</h3>
      <p>This is your one-time approval preview. Creation will preserve this vibe and backfill any misses automatically to hit exact length.</p>
      <p><strong>Matched now:</strong> ${data.matched.length}/${data.previewTrackCount}</p>
      <p><strong>Unmatched now:</strong> ${data.unmatched.length}</p>
      <h4>Preview tracklist (all requested tracks)</h4>
      ${renderPreviewRows(data.previewRows || [])}
      <h4>Preview tracklist (actual Spotify matches)</h4>
      <pre>${renderMatchedTrackList(data.matched)}</pre>
    `);
  } catch (err) {
    showPreview(`<h3>Preview Error</h3><pre>${err.message}</pre>`);
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview Tracklist';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = getFormPayload();
  payload.approvedTracks = latestPreview?.matched || [];

  createBtn.disabled = true;
  createBtn.textContent = 'Creating Playlist...';

  try {
    const res = await fetch('/api/create-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    showResult(`
      <h3>Playlist created</h3>
      <p><strong>Name:</strong> ${data.effectiveName}</p>
      <p><strong>Final length:</strong> ${data.trackCountCreated}/${data.trackCountRequested}</p>
      <p><a href="${data.playlistUrl}" target="_blank" rel="noreferrer">Open in Spotify</a></p>
      ${data.duplicateFillCount ? `<p><em>${data.duplicateFillCount} duplicate tracks were used as a last-resort fill to keep exact length.</em></p>` : ''}
      ${data.note ? `<p><em>${data.note}</em></p>` : ''}
      <h4>Final tracklist (actual Spotify tracks added)</h4>
      <pre>${renderMatchedTrackList(data.matched)}</pre>
    `);
  } catch (err) {
    showResult(`<h3>Error</h3><pre>${err.message}</pre>`);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Create Playlist in Spotify';
  }
});

refreshStatus().catch((err) => {
  statusEl.textContent = `Status check failed: ${err.message}`;
});
