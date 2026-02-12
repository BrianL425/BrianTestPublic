# Spotify Autify

Natural-language playlist builder for Spotify:
1. Describe the playlist you want.
2. Preview the generated tracklist once and approve it.
3. The app creates a Spotify playlist and backfills until final Spotify length matches your requested count.

## Important Spotify API limitation
Spotify's public Web API currently does **not** support placing playlists into user folders. This app accepts a folder name and applies it as a playlist name prefix (example: `[Focus] Late Night Coding`).

## Prerequisites
- Node.js 18+
- OpenAI API key
- Spotify app credentials from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)

## Spotify app setup
In your Spotify app settings, add this Redirect URI exactly:
- `http://127.0.0.1:3000/auth/spotify/callback`

## Run locally
```bash
cp .env.example .env
# fill in values in .env
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy on Render (public URL)
1. Push this project to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select your repo (Render will detect `render.yaml`).
4. Set required environment variables in Render:
   - `OPENAI_API_KEY`
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `SPOTIFY_REDIRECT_URI` (use your Render URL callback)
   - `SLACK_BOT_TOKEN` (if using Slack)
   - `SLACK_SIGNING_SECRET` (optional currently)
5. Deploy. Render will provide a URL like `https://spotify-autify.onrender.com`.

After deploy:
- Update Spotify redirect URI to:
  - `https://<your-render-domain>/auth/spotify/callback`
- Update Slack endpoints:
  - Slash command: `https://<your-render-domain>/slack/commands`
  - Interactivity: `https://<your-render-domain>/slack/interactions`

## Environment variables
- `OPENAI_API_KEY`: OpenAI key
- `OPENAI_MODEL`: defaults to `gpt-4o-mini`
- `SPOTIFY_CLIENT_ID`: Spotify client ID
- `SPOTIFY_CLIENT_SECRET`: Spotify client secret
- `SPOTIFY_REDIRECT_URI`: OAuth callback URL
- `SLACK_BOT_TOKEN`: Slack bot token (for slash command integration)
- `SLACK_SIGNING_SECRET`: Slack signing secret (optional, reserved for request verification hardening)
- `PORT`: server port (default 3000)

## What the app does
- `GET /auth/spotify`: starts Spotify OAuth
- `GET /auth/spotify/callback`: stores tokens in-memory
- `POST /api/preview-playlist`: generates preview tracklist (approval step)
- `POST /api/create-playlist`: generates tracks, matches Spotify songs, creates playlist, adds tracks
- `POST /api/debug/spotify`: runs granular Spotify API diagnostics
- `POST /slack/commands`: slash commands endpoint (`/spotAI`)
- `POST /slack/interactions`: Slack button action endpoint

## Slack integration (`/spotAI`)
1. Create a Slack app and enable slash commands.
2. Create command: `/spotAI`
3. Set slash command Request URL: `https://<your-public-url>/slack/commands`
4. Enable Interactivity and set Request URL: `https://<your-public-url>/slack/interactions`
5. Add bot scopes: `chat:write`, `commands`
6. Install app to workspace and copy Bot User OAuth Token to `SLACK_BOT_TOKEN`.
7. Use command format:
   - `/spotAI desc=hipster tracks to code to; name=Chilly in Willy; folder=Spotify AI; count=20; public=false`

The bot sends an ephemeral preview with matched/missed indicators and an `Approve & Create` button.

## Notes
- Tokens are stored in-memory for local development. Restarting server clears connection.
- Some generated songs may not match exactly on Spotify; unmatched tracks are shown in the UI.
