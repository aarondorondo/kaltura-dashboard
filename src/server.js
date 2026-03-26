import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { generateKS, verifyEntry, pollTick } from './kaltura.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '50', 10);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Security Middleware ─────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' },
}));

app.use(express.json());

// ── Session Store ───────────────────────────────────────────────────────────

const sessions = new Map();

function freshSession() {
  return {
    active: false,
    status: 'idle',
    authMode: null,
    serviceUrl: null,
    partnerId: null,
    adminSecret: null,
    currentKS: null,
    ksGeneratedAt: null,
    entryId: null,
    entryName: null,
    streamLabel: null,
    pollIntervalMs: null,
    pollIntervalLabel: null,
    startTime: null,
    endTime: null,
    monitoringSince: null,
    lastPoll: null,
    nextPollAt: null,
    selectedMetrics: {},
    latestMetrics: {},
    previousMetrics: null,
    history: [],
    dataPoints: 0,
    warnings: [],
    lastError: null,
    disabledServices: new Set(),
    pollIntervalHandle: null,
    startTimeoutHandle: null,
    endTimeoutHandle: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function getSession(req, res) {
  const sid = req.query.sid || req.headers['x-session-id'] || req.body?.sessionId;
  if (!sid) {
    res.status(400).json({ success: false, error: 'Missing session ID.' });
    return null;
  }
  const session = sessions.get(sid);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found. It may have expired.' });
    return null;
  }
  session.lastActivity = Date.now();
  return { sid, session };
}

function cleanupSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  clearTimeout(session.startTimeoutHandle);
  clearTimeout(session.endTimeoutHandle);
  clearInterval(session.pollIntervalHandle);
  sessions.delete(sid);
}

// Periodic cleanup of stale sessions (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`[Cleanup] Removing stale session ${sid.slice(0, 8)}...`);
      cleanupSession(sid);
    }
  }
}, 60 * 60 * 1000);

function safeSessionState(session) {
  return {
    active: session.active,
    status: session.status,
    entryId: session.entryId,
    entryName: session.entryName,
    streamLabel: session.streamLabel,
    pollIntervalMs: session.pollIntervalMs,
    pollIntervalLabel: session.pollIntervalLabel,
    startTime: session.startTime,
    endTime: session.endTime,
    monitoringSince: session.monitoringSince,
    lastPoll: session.lastPoll,
    nextPollAt: session.nextPollAt,
    selectedMetrics: session.selectedMetrics,
    latestMetrics: session.latestMetrics,
    previousMetrics: session.previousMetrics,
    history: session.history,
    dataPoints: session.dataPoints,
    warnings: [...session.warnings],
    lastError: session.lastError,
  };
}

// ── Static Files ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GET /api/health ─────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), activeSessions: sessions.size });
});

// ── GET /api/status ─────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const result = getSession(req, res);
  if (!result) return;
  res.json(safeSessionState(result.session));
});

// ── POST /api/start ─────────────────────────────────────────────────────────

app.post('/api/start', async (req, res) => {
  try {
    // Check session limit
    if (sessions.size >= MAX_SESSIONS) {
      return res.status(503).json({
        success: false,
        error: 'Server is at capacity. Please try again later.',
      });
    }

    const {
      authMode,
      serviceUrl,
      partnerId,
      adminSecret,
      ksToken,
      entryId,
      streamLabel,
      pollIntervalMs,
      pollIntervalLabel,
      startTime,
      endTime,
      selectedMetrics,
    } = req.body;

    // If client sends an existing sessionId, clean it up first
    const existingSid = req.body.sessionId;
    if (existingSid && sessions.has(existingSid)) {
      cleanupSession(existingSid);
    }

    const sid = crypto.randomUUID();
    const session = freshSession();
    sessions.set(sid, session);

    // Store config in session
    session.authMode = authMode;
    session.serviceUrl = (serviceUrl || '').replace(/\/+$/, '');
    session.entryId = entryId;
    session.streamLabel = streamLabel || null;
    session.pollIntervalMs = pollIntervalMs;
    session.pollIntervalLabel = pollIntervalLabel;
    session.startTime = startTime;
    session.endTime = endTime || null;
    session.selectedMetrics = selectedMetrics || {};
    session.active = true;

    const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
    console.log(`[Session ${sid.slice(0, 8)}] Starting — authMode=${authMode}, entryId=${entryId}, interval=${pollIntervalMs}ms, ip=${clientIP}`);

    // Authenticate
    if (authMode === 'credentials') {
      session.partnerId = partnerId;
      session.adminSecret = adminSecret;
      try {
        await generateKS(session);
      } catch (err) {
        console.log(`[Session ${sid.slice(0, 8)}] Auth failed: ${err.message}`);
        cleanupSession(sid);
        return res.status(401).json({
          success: false,
          error: 'Authentication failed. Check your Partner ID and Admin Secret.',
          field: 'adminSecret',
        });
      }
    } else {
      session.currentKS = ksToken;
      session.ksGeneratedAt = null;
      try {
        const parts = Buffer.from(ksToken.split('|')[0], 'base64').toString().split('|');
        session.partnerId = parts[1] || null;
      } catch {
        session.partnerId = null;
      }
    }

    // Verify entry
    const entryResult = await verifyEntry(session);
    if (!entryResult.success) {
      console.log(`[Session ${sid.slice(0, 8)}] Entry verification failed: ${entryResult.code} — ${entryResult.message}`);
      const isAuthErr =
        entryResult.code === 'INVALID_KS' ||
        entryResult.code === 'KS_EXPIRED' ||
        entryResult.code === 'INVALID_SESSION';
      cleanupSession(sid);
      if (isAuthErr) {
        return res.status(401).json({
          success: false,
          error: 'Authentication failed.',
          field: 'adminSecret',
        });
      }
      return res.status(404).json({
        success: false,
        error: 'Entry not found. Check your Entry ID.',
        field: 'entryId',
      });
    }

    session.entryName = entryResult.name;
    if (!session.streamLabel) session.streamLabel = entryResult.name;

    // Schedule polling
    const now = Date.now();
    const startDelay = Math.max(0, new Date(startTime).getTime() - now);

    function beginPolling() {
      session.status = 'live';
      session.monitoringSince = new Date().toISOString();
      pollTick(session);
      session.pollIntervalHandle = setInterval(() => pollTick(session), session.pollIntervalMs);
    }

    function autoStop() {
      clearInterval(session.pollIntervalHandle);
      session.status = 'complete';
      session.active = false;
      console.log(`[Session ${sid.slice(0, 8)}] Auto-stopped at end time. ${session.dataPoints} snapshots collected.`);
    }

    if (startDelay > 0) {
      session.status = 'waiting';
      session.startTimeoutHandle = setTimeout(beginPolling, startDelay);
      console.log(`[Session ${sid.slice(0, 8)}] Waiting — polling starts in ${Math.round(startDelay / 1000)}s`);
    } else {
      beginPolling();
    }

    if (endTime) {
      const endDelay = new Date(endTime).getTime() - now;
      if (endDelay > 0) {
        session.endTimeoutHandle = setTimeout(autoStop, endDelay);
      }
    }

    return res.json({
      success: true,
      sessionId: sid,
      entryName: session.entryName,
      entryId: session.entryId,
    });
  } catch (err) {
    console.error('[/api/start] Unhandled error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/stop ──────────────────────────────────────────────────────────

app.post('/api/stop', (req, res) => {
  try {
    const result = getSession(req, res);
    if (!result) return;
    const { sid, session } = result;

    clearTimeout(session.startTimeoutHandle);
    clearTimeout(session.endTimeoutHandle);
    clearInterval(session.pollIntervalHandle);
    session.status = 'idle';
    session.active = false;
    console.log(`[Session ${sid.slice(0, 8)}] Stopped. ${session.dataPoints} snapshots collected.`);

    // Remove session from store after stop
    sessions.delete(sid);

    return res.json({ success: true });
  } catch (err) {
    console.error('[/api/stop] Unhandled error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Catch-all error handler ─────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Kaltura Live Analytics Dashboard running on port ${PORT}`);
});
