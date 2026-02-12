import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import OpenAI from 'openai';

const {
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:3000/auth/spotify/callback',
  SLACK_BOT_TOKEN = '',
  SLACK_SIGNING_SECRET = '',
  PORT = 3000
} = process.env;

if (!OPENAI_API_KEY || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('Missing required env vars. Check README.md for setup.');
  process.exit(1);
}

const app = express();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const session = {
  state: null,
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  userId: null,
  userEmail: null,
  scope: null
};

const pendingSlackApprovals = new Map();

const EMERGENCY_FALLBACK_TRACKS = [
  { title: 'Blinding Lights', artist: 'The Weeknd' },
  { title: 'Dreams', artist: 'Fleetwood Mac' },
  { title: 'Electric Feel', artist: 'MGMT' },
  { title: 'Sunset Lover', artist: 'Petit Biscuit' },
  { title: 'Midnight City', artist: 'M83' },
  { title: 'Tame', artist: 'STRFKR' },
  { title: 'Intro', artist: 'The xx' },
  { title: 'Innerbloom', artist: 'RUFUS DU SOL' },
  { title: 'Something About Us', artist: 'Daft Punk' },
  { title: 'A Moment Apart', artist: 'ODESZA' }
];

function clampTrackCount(value) {
  return Math.min(Math.max(Number(value) || 20, 5), 50);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeTrackKey(title, artist) {
  return `${normalizeText(title)}|${normalizeText(artist)}`;
}

function getSpotifyAuthHeader() {
  const creds = `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

async function refreshSpotifyTokenIfNeeded() {
  if (!session.refreshToken) throw new Error('Spotify not connected');
  if (Date.now() < session.expiresAt - 60_000) return;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: getSpotifyAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed refreshing token: ${text}`);
  }

  const data = await response.json();
  session.accessToken = data.access_token;
  session.expiresAt = Date.now() + data.expires_in * 1000;
  if (data.scope) session.scope = data.scope;
}

async function spotifyRequest(path, options = {}) {
  await refreshSpotifyTokenIfNeeded();

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Spotify API error (${response.status}): ${text}`);
    err.status = response.status;
    err.responseBody = text;
    throw err;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parsePotentialJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return valid JSON');
  return JSON.parse(match[0]);
}

async function generateTracklist({ description, trackCount, excludedTracks = [] }) {
  const exclusions = excludedTracks.slice(0, 40).map((t) => `${t.title} - ${t.artist}`).join('; ');

  const prompt = [
    'Generate a tracklist for Spotify based on this user request.',
    `Description: ${description}`,
    `Number of tracks: ${trackCount}`,
    exclusions ? `Avoid duplicates and avoid these tracks: ${exclusions}` : '',
    'Return only JSON in this exact shape:',
    '{"tracks":[{"title":"...","artist":"..."}]}'
  ]
    .filter(Boolean)
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.9,
    messages: [
      {
        role: 'system',
        content: 'You are a precise music curator. Return only valid JSON. Use real songs and artists.'
      },
      { role: 'user', content: prompt }
    ]
  });

  const content = completion.choices?.[0]?.message?.content || '';
  const parsed = parsePotentialJson(content);

  if (!Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
    throw new Error('Generated tracklist was empty or malformed');
  }

  return parsed.tracks
    .filter((t) => t?.title && t?.artist)
    .slice(0, trackCount)
    .map((t) => ({ title: String(t.title).trim(), artist: String(t.artist).trim() }));
}

function getArtistConfidence(itemArtists, requestedArtist) {
  const requested = normalizeText(requestedArtist);
  if (!requested) return 0;
  const requestedTokens = requested.split(' ').filter(Boolean);
  if (requestedTokens.length === 0) return 0;

  let best = 0;
  for (const artist of itemArtists || []) {
    const candidate = normalizeText(artist?.name || '');
    if (!candidate) continue;
    if (candidate === requested) return 1;
    if (candidate.includes(requested) || requested.includes(candidate)) {
      best = Math.max(best, 0.92);
      continue;
    }

    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    const overlap = requestedTokens.filter((t) => candidateTokens.has(t)).length;
    const score = overlap / requestedTokens.length;
    best = Math.max(best, score);
  }

  return best;
}

function pickBestTrackCandidate(items, requestedArtist) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const scored = items
    .map((item) => ({
      item,
      score: getArtistConfidence(item?.artists || [], requestedArtist)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0.8) return null;
  return best.item;
}

async function findSpotifyTrackUri({ title, artist }) {
  const queries = [
    `track:${title} artist:${artist}`,
    `${title} ${artist}`
  ];

  for (const query of queries) {
    const encoded = encodeURIComponent(query);
    const data = await spotifyRequest(`/search?q=${encoded}&type=track&limit=5`);
    const items = data?.tracks?.items || [];
    const best = pickBestTrackCandidate(items, artist);
    if (best?.uri) {
      return {
        uri: best.uri,
        matchedName: `${best.name} - ${best.artists.map((a) => a.name).join(', ')}`
      };
    }
  }

  return null;
}

async function matchCandidatesToSpotify(candidates, usedUris, attemptedTrackKeys, matchedOut, unmatchedOut) {
  for (const candidate of candidates) {
    const key = makeTrackKey(candidate.title, candidate.artist);
    if (attemptedTrackKeys.has(key)) continue;
    attemptedTrackKeys.add(key);

    const match = await findSpotifyTrackUri(candidate);
    if (match?.uri) {
      if (!usedUris.has(match.uri)) {
        usedUris.add(match.uri);
        matchedOut.push({
          requested: candidate,
          matched: match.matchedName,
          uri: match.uri
        });
      }
    } else {
      unmatchedOut.push(candidate);
    }
  }
}

async function buildMatchedTrackPool({ description, desiredCount, seedCandidates = [] }) {
  const matched = [];
  const unmatched = [];
  const usedUris = new Set();
  const attemptedTrackKeys = new Set();

  await matchCandidatesToSpotify(seedCandidates, usedUris, attemptedTrackKeys, matched, unmatched);

  let attempt = 0;
  const maxAttempts = 8;
  while (matched.length < desiredCount && attempt < maxAttempts) {
    attempt += 1;
    const needed = desiredCount - matched.length;
    const generateCount = Math.min(50, Math.max(needed * 3, 8));

    const excludedTracks = [...matched.map((m) => m.requested), ...unmatched].slice(0, 80);
    const generated = await generateTracklist({
      description,
      trackCount: generateCount,
      excludedTracks
    });

    await matchCandidatesToSpotify(generated, usedUris, attemptedTrackKeys, matched, unmatched);
  }

  if (matched.length < desiredCount) {
    await matchCandidatesToSpotify(
      EMERGENCY_FALLBACK_TRACKS,
      usedUris,
      attemptedTrackKeys,
      matched,
      unmatched
    );
  }

  let duplicateFillCount = 0;
  if (matched.length < desiredCount && matched.length > 0) {
    const base = [...matched];
    let idx = 0;
    while (matched.length < desiredCount) {
      const clone = base[idx % base.length];
      matched.push({
        requested: clone.requested,
        matched: `${clone.matched} (duplicate fill)`,
        uri: clone.uri,
        duplicated: true
      });
      duplicateFillCount += 1;
      idx += 1;
    }
  }

  if (matched.length < desiredCount) {
    throw new Error(`Unable to build required track count (${matched.length}/${desiredCount})`);
  }

  return {
    matched: matched.slice(0, desiredCount),
    unmatched,
    duplicateFillCount
  };
}

function isConnected() {
  return Boolean(session.accessToken && session.userId);
}

function parseSpotifyErrorMessage(err) {
  let details = '';
  try {
    const parsed = JSON.parse(err?.responseBody || '{}');
    details = parsed?.error?.message ? ` Spotify says: ${parsed.error.message}` : '';
  } catch {
    details = err?.responseBody ? ` Spotify says: ${err.responseBody}` : '';
  }
  return details;
}

function isSlackConfigured() {
  return Boolean(SLACK_BOT_TOKEN);
}

async function slackApi(method, payload) {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error || 'unknown_error'}`);
  }
  return data;
}

async function createPlaylistFromInputs({
  description,
  playlistName,
  folderName = '',
  trackCount = 20,
  isPublic = false,
  approvedTracks = []
}) {
  const count = clampTrackCount(trackCount);
  const seedCandidates = Array.isArray(approvedTracks)
    ? approvedTracks
        .filter((t) => t?.requested?.title && t?.requested?.artist)
        .map((t) => ({ title: t.requested.title, artist: t.requested.artist }))
    : [];

  if (seedCandidates.length === 0) {
    const initialGenerated = await generateTracklist({ description, trackCount: count });
    seedCandidates.push(...initialGenerated);
  }

  const { matched, unmatched, duplicateFillCount } = await buildMatchedTrackPool({
    description,
    desiredCount: count,
    seedCandidates
  });

  const effectiveName = folderName.trim()
    ? `[${folderName.trim()}] ${playlistName.trim()}`
    : playlistName.trim();

  const created = await spotifyRequest('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name: effectiveName,
      public: Boolean(isPublic),
      description: `Generated from prompt: ${description.slice(0, 250)}`
    })
  });

  const uris = matched.map((m) => m.uri);
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyRequest(`/playlists/${created.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: uris.slice(i, i + 100) })
    });
  }

  return {
    playlistId: created.id,
    playlistUrl: created.external_urls.spotify,
    effectiveName,
    trackCountRequested: count,
    trackCountCreated: uris.length,
    matched,
    unmatched,
    duplicateFillCount,
    note: folderName.trim()
      ? 'Spotify Web API does not support real playlist folder placement; folder was added as a playlist name prefix.'
      : null
  };
}

app.get('/api/status', (_req, res) => {
  res.json({
    connected: isConnected(),
    userId: session.userId,
    userEmail: session.userEmail,
    scope: session.scope
  });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/auth/spotify', (_req, res) => {
  const state = crypto.randomUUID();
  session.state = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: 'playlist-modify-private playlist-modify-public user-read-email',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || state !== session.state) {
      return res.status(400).send('Invalid Spotify OAuth callback');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: SPOTIFY_REDIRECT_URI
    });

    const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: getSpotifyAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return res.status(400).send(`Token exchange failed: ${text}`);
    }

    const tokenData = await tokenResp.json();
    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token;
    session.expiresAt = Date.now() + tokenData.expires_in * 1000;
    session.scope = tokenData.scope || null;

    const me = await spotifyRequest('/me');
    session.userId = me.id;
    session.userEmail = me.email || null;

    res.redirect('/?connected=1');
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.post('/api/preview-playlist', async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(401).json({ error: 'Connect Spotify first' });
    }

    const { description, trackCount = 20 } = req.body || {};
    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    const count = clampTrackCount(trackCount);
    const generatedTracks = await generateTracklist({ description, trackCount: count });

    const matched = [];
    const unmatched = [];
    const previewRows = [];
    const usedUris = new Set();
    const attemptedTrackKeys = new Set();

    for (const candidate of generatedTracks) {
      const key = makeTrackKey(candidate.title, candidate.artist);
      if (!attemptedTrackKeys.has(key)) attemptedTrackKeys.add(key);

      const match = await findSpotifyTrackUri(candidate);
      if (match?.uri) {
        if (!usedUris.has(match.uri)) {
          usedUris.add(match.uri);
          matched.push({
            requested: candidate,
            matched: match.matchedName,
            uri: match.uri
          });
        }
        previewRows.push({
          requested: candidate,
          matched: true,
          matchedName: match.matchedName
        });
      } else {
        unmatched.push(candidate);
        previewRows.push({
          requested: candidate,
          matched: false,
          matchedName: null
        });
      }
    }

    res.json({
      previewTrackCount: count,
      generatedTracks,
      previewRows,
      matched,
      unmatched
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-playlist', async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(401).json({ error: 'Connect Spotify first' });
    }

    const {
      description,
      playlistName,
      folderName = '',
      trackCount = 20,
      isPublic = false,
      approvedTracks = []
    } = req.body || {};

    if (!description || !playlistName) {
      return res.status(400).json({ error: 'description and playlistName are required' });
    }

    const created = await createPlaylistFromInputs({
      description,
      playlistName,
      folderName,
      trackCount,
      isPublic,
      approvedTracks
    });

    res.json(created);
  } catch (err) {
    console.error(err);
    if (err?.status === 403) {
      return res.status(403).json({
        error:
          'Spotify denied this operation (403). Verify this account is allowlisted for the same app as your .env credentials, then reconnect Spotify and retry.' +
          parseSpotifyErrorMessage(err) +
          (session.scope ? ` Granted scopes: ${session.scope}` : '')
      });
    }
    res.status(500).json({ error: err.message });
  }
});

function parseSpotAiCommand(text) {
  const raw = String(text || '').trim();
  const defaults = {
    playlistName: 'Autify Playlist',
    folderName: 'Autify',
    trackCount: 20,
    isPublic: false,
    description: ''
  };

  if (!raw) return defaults;

  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  const parsed = { ...defaults };
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key === 'name') parsed.playlistName = value;
    if (key === 'folder') parsed.folderName = value;
    if (key === 'count') parsed.trackCount = clampTrackCount(value);
    if (key === 'public') parsed.isPublic = ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
    if (key === 'desc' || key === 'description') parsed.description = value;
  }
  return parsed;
}

function slackEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

app.post('/slack/commands', async (req, res) => {
  try {
    if (!isSlackConfigured()) {
      return res.status(500).send('Slack is not configured on this server.');
    }
    if (!isConnected()) {
      return res.status(400).send('Spotify is not connected yet. Connect Spotify in the web app first.');
    }

    const { command, text = '', channel_id: channelId, user_id: userId, trigger_id: triggerId } = req.body || {};
    if (command !== '/spotAI') {
      return res.send(`Unknown command ${command}. Use /spotAI`);
    }

    const parsed = parseSpotAiCommand(text);
    if (!parsed.description) {
      return res.send(
        'Usage: /spotAI desc=your vibe; name=Playlist Name; folder=Folder Label; count=20; public=false'
      );
    }

    const generatedTracks = await generateTracklist({
      description: parsed.description,
      trackCount: parsed.trackCount
    });
    const matched = [];
    const unmatched = [];
    const previewRows = [];
    const usedUris = new Set();
    const attemptedTrackKeys = new Set();

    for (const candidate of generatedTracks) {
      const key = makeTrackKey(candidate.title, candidate.artist);
      if (!attemptedTrackKeys.has(key)) attemptedTrackKeys.add(key);
      const match = await findSpotifyTrackUri(candidate);

      if (match?.uri && !usedUris.has(match.uri)) {
        usedUris.add(match.uri);
        matched.push({
          requested: candidate,
          matched: match.matchedName,
          uri: match.uri
        });
        previewRows.push({
          requested: candidate,
          matched: true,
          matchedName: match.matchedName
        });
      } else {
        unmatched.push(candidate);
        previewRows.push({
          requested: candidate,
          matched: false,
          matchedName: null
        });
      }
    }

    const approvalId = crypto.randomUUID();
    pendingSlackApprovals.set(approvalId, {
      createdAt: Date.now(),
      payload: {
        description: parsed.description,
        playlistName: parsed.playlistName,
        folderName: parsed.folderName,
        trackCount: parsed.trackCount,
        isPublic: parsed.isPublic,
        approvedTracks: matched
      },
      channelId,
      userId
    });

    const previewLines = previewRows
      .slice(0, 20)
      .map((r, idx) => {
        const icon = r.matched ? '✅' : '⚪';
        const reqText = `${r.requested.title} - ${r.requested.artist}`;
        const matchText = r.matchedName ? ` -> ${r.matchedName}` : '';
        return `${idx + 1}. ${icon} ${reqText}${matchText}`;
      })
      .join('\n');

    await slackApi('chat.postEphemeral', {
      channel: channelId,
      user: userId,
      text: 'SpotAI preview ready',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*SpotAI Preview*\\n` +
              `*Name:* ${slackEscape(parsed.playlistName)}\\n` +
              `*Folder:* ${slackEscape(parsed.folderName)}\\n` +
              `*Matched:* ${matched.length}/${parsed.trackCount}\\n` +
              `*Prompt:* ${slackEscape(parsed.description)}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `\\n${slackEscape(previewLines)}`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Approve & Create' },
              action_id: 'spotai_approve_create',
              value: approvalId
            }
          ]
        }
      ]
    });

    if (triggerId) {
      return res.send('SpotAI preview sent to you as an ephemeral Slack message. Review and click Approve & Create.');
    }
    return res.send('SpotAI preview sent.');
  } catch (err) {
    console.error(err);
    return res.status(500).send(`SpotAI command failed: ${err.message}`);
  }
});

app.post('/slack/interactions', async (req, res) => {
  try {
    if (!isSlackConfigured()) {
      return res.status(500).send('Slack is not configured.');
    }
    const payload = JSON.parse(req.body?.payload || '{}');
    if (payload.type !== 'block_actions') {
      return res.json({ ok: true });
    }

    const action = payload.actions?.[0];
    if (!action || action.action_id !== 'spotai_approve_create') {
      return res.json({ ok: true });
    }

    const approvalId = action.value;
    const pending = pendingSlackApprovals.get(approvalId);
    if (!pending) {
      return res.json({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'This approval request expired. Run /spotAI again.'
      });
    }
    pendingSlackApprovals.delete(approvalId);

    res.json({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'Creating playlist in Spotify...'
    });

    try {
      const created = await createPlaylistFromInputs(pending.payload);
      await slackApi('chat.postEphemeral', {
        channel: pending.channelId,
        user: pending.userId,
        text: `Playlist created: ${created.playlistUrl}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*Playlist Created*\\n` +
                `*Name:* ${slackEscape(created.effectiveName)}\\n` +
                `*Length:* ${created.trackCountCreated}/${created.trackCountRequested}\\n` +
                `<${created.playlistUrl}|Open in Spotify>`
            }
          }
        ]
      });
    } catch (err) {
      await slackApi('chat.postEphemeral', {
        channel: pending.channelId,
        user: pending.userId,
        text: `Playlist creation failed: ${err.message}`
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).send(`Interaction failed: ${err.message}`);
  }
});

app.post('/api/debug/spotify', async (_req, res) => {
  if (!isConnected()) {
    return res.status(401).json({ error: 'Connect Spotify first' });
  }

  const steps = [];

  async function runStep(name, fn) {
    try {
      const data = await fn();
      steps.push({ name, ok: true, data });
      return { ok: true, data };
    } catch (err) {
      let details = err?.responseBody || '';
      try {
        const parsed = JSON.parse(details || '{}');
        details = parsed?.error?.message || details;
      } catch {}
      steps.push({
        name,
        ok: false,
        error: {
          message: err?.message || 'Unknown error',
          status: err?.status || null,
          details: details || null
        }
      });
      return { ok: false };
    }
  }

  const meStep = await runStep('GET /me', async () => {
    const me = await spotifyRequest('/me');
    return { id: me.id, email: me.email || null };
  });

  if (meStep.ok) {
    await runStep('POST /me/playlists', async () => {
      const created = await spotifyRequest('/me/playlists', {
        method: 'POST',
        body: JSON.stringify({
          name: `[DEBUG] API Check ${Date.now()}`,
          public: false,
          description: 'Spotify Autify diagnostics'
        })
      });

      await spotifyRequest(`/playlists/${created.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris: ['spotify:track:0VjIjW4GlUZAMYd2vXMi3b'] })
      });

      return { playlistId: created.id };
    });
  }

  res.status(steps.some((s) => !s.ok) ? 207 : 200).json({
    summary: {
      connectedUserId: session.userId,
      connectedEmail: session.userEmail,
      grantedScopes: session.scope || null
    },
    steps
  });
});

if (!process.env.VERCEL) {
  app.listen(Number(PORT), () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}

export default app;
