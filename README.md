# Kaltura Live Analytics Dashboard

## Quick Start — Local
**Mac/Linux:** Double-click `launch.command`
**Windows:** Double-click `launch.bat`

Your browser will open automatically. No other setup required.

## Quick Start — Web Deployment
Deploy to any Node.js hosting platform:

```bash
# Heroku
heroku create
git push heroku main

# Railway / Render / Fly.io
# Connect your repo and set start command: node src/server.js

# Manual
npm install
PORT=8080 node src/server.js
```

The app runs on the `PORT` environment variable (default 3000).

---

## First Time Only (Local)
If double-clicking doesn't work on Mac:
  Right-click launch.command → Open → Open (to bypass Gatekeeper)
Node.js 18 or later must be installed: https://nodejs.org

Make sure launch.command is executable: `chmod +x launch.command`

---

## Finding Your Kaltura Credentials
- **Partner ID & Admin Secret:** KMC → Settings → Integration Settings
- **Entry ID:** KMC → Content → click your live entry → copy the ID (starts with 1_)
- **KS Token:** Generate one in the Kaltura API Explorer or your own tooling

---

## How It Works
The server proxies all Kaltura API calls — your credentials are sent to the server,
used to communicate with Kaltura, and held only in memory for the duration of
your session. They are never stored to disk or logged.

Multiple users can connect simultaneously, each monitoring their own stream
independently. Sessions are isolated and automatically cleaned up after 24 hours.

---

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `MAX_SESSIONS` | `50` | Maximum concurrent monitoring sessions |

---

## Troubleshooting
- **"Entry not found"** — Entry ID must start with 1_ and exist in your account
- **Viewers showing 0** — Stream may not be actively broadcasting yet
- **Reactions/Chat/Questions = 0** — These features may not be enabled on your
  Kaltura account. This is normal for many live stream configurations.
- **KS token expired** — Reconnect with a fresh token, or switch to Credentials mode
- **"Session not found"** — Your session may have expired (24h limit). Reconnect.
- **"Server is at capacity"** — Too many active sessions. Wait or increase `MAX_SESSIONS`.
