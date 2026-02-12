#!/bin/zsh
cd "/Users/brian/Documents/Spotify Autify"

# If an old server is still using port 3000, stop it first.
EXISTING_PID=$(lsof -ti tcp:3000 2>/dev/null)
if [ -n "$EXISTING_PID" ]; then
  kill "$EXISTING_PID" 2>/dev/null
  sleep 1
fi

if [ ! -d node_modules ]; then
  npm install
fi
npm run dev
