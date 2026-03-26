#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi
node src/server.js &
SERVER_PID=$!
sleep 1.5
open http://localhost:3000
# xdg-open http://localhost:3000  # Linux fallback
wait $SERVER_PID
