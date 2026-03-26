import axios from 'axios';

/**
 * Kaltura API helper — all Kaltura HTTP calls live here.
 * Every function receives the session object so it can read/write KS, serviceUrl, etc.
 */

// ── KS Generation ───────────────────────────────────────────────────────────

export async function generateKS(session) {
  const url = `${session.serviceUrl}/api_v3/service/session/action/start`;
  const params = new URLSearchParams({
    format: '1',
    partnerId: session.partnerId,
    secret: session.adminSecret,
    type: '2',
    expiry: '86400',
  });

  console.log(`[KS] Generating new KS for partnerId ${session.partnerId}`);
  const { data } = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // Kaltura returns the KS string directly on success, or an error object
  if (data && typeof data === 'object' && data.objectType === 'KalturaAPIException') {
    console.log(`[KS] Generation failed: ${data.code} — ${data.message}`);
    throw new Error(data.message || 'KS generation failed');
  }

  session.currentKS = data;
  session.ksGeneratedAt = Date.now();
  console.log(`[KS] Generated new KS for partnerId ${session.partnerId}`);
  return data;
}

export async function refreshKSIfNeeded(session) {
  if (session.authMode !== 'credentials') return;
  if (!session.ksGeneratedAt) return;

  const elapsed = Date.now() - session.ksGeneratedAt;
  if (elapsed > 55 * 60 * 1000) {
    console.log('[KS] KS is older than 55 minutes — refreshing');
    await generateKS(session);
  }
}

// Handle INVALID_KS / KS_EXPIRED errors
export async function handleKSError(session, errorCode, retryFn) {
  if (errorCode !== 'INVALID_KS' && errorCode !== 'KS_EXPIRED') return null;

  if (session.authMode === 'credentials') {
    console.log(`[KS] ${errorCode} — regenerating KS and retrying`);
    await generateKS(session);
    return retryFn();
  }

  // KS mode — cannot refresh, stop polling
  console.log(`[KS] ${errorCode} in KS mode — stopping polling`);
  session.status = 'error';
  session.lastError =
    'KS token has expired. Disconnect and reconnect with a new token, or switch to Credentials mode.';
  clearInterval(session.pollIntervalHandle);
  clearTimeout(session.startTimeoutHandle);
  clearTimeout(session.endTimeoutHandle);
  session.active = false;
  return null;
}

// ── Entry Verification ──────────────────────────────────────────────────────

export async function verifyEntry(session) {
  const url = `${session.serviceUrl}/api_v3/service/media/action/get`;
  const params = { ks: session.currentKS, entryId: session.entryId, format: 1 };

  console.log(`[Entry] Verifying entryId=${session.entryId}`);
  const { data } = await axios.get(url, { params });
  console.log(`[Entry] Response objectType=${data?.objectType}`);

  if (data?.objectType === 'KalturaAPIException') {
    return { success: false, code: data.code, message: data.message };
  }

  return { success: true, name: data.name };
}

// ── Metric Fetchers ─────────────────────────────────────────────────────────

function isServiceForbidden(data) {
  return (
    data?.objectType === 'KalturaAPIException' &&
    (data.code === 'SERVICE_FORBIDDEN' || data.code === 'INVALID_OBJECT_TYPE')
  );
}

function isKSError(data) {
  return (
    data?.objectType === 'KalturaAPIException' &&
    (data.code === 'INVALID_KS' || data.code === 'KS_EXPIRED')
  );
}

// ── Report Helper ────────────────────────────────────────────────────────────

function parseReportTotal(data) {
  if (!data?.header || !data?.data) return {};
  const headers = data.header.split(',');
  const values = data.data.split(',');
  const result = {};
  headers.forEach((h, i) => {
    result[h.trim()] = values[i]?.trim() || '0';
  });
  return result;
}

async function fetchReportTotal(session, reportType, fromDate, toDate) {
  const url = `${session.serviceUrl}/api_v3/service/report/action/getTotal`;
  const params = new URLSearchParams({
    ks: session.currentKS,
    format: '1',
    reportType: String(reportType),
    'reportInputFilter[objectType]': 'KalturaReportInputFilter',
    'reportInputFilter[entryIdIn]': session.entryId,
    'reportInputFilter[fromDate]': String(fromDate),
    'reportInputFilter[toDate]': String(toDate),
  });
  const { data } = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

// ── Viewers ──────────────────────────────────────────────────────────────────

export async function fetchViewers(session) {
  if (session.disabledServices.has('viewers')) return 0;

  const now = Math.floor(Date.now() / 1000);

  // Primary: LIVE_MEETING_USERS_OVERVIEW_REALTIME (10016)
  // Returns view_unique_combined_live_audience — active users right now
  try {
    const data = await fetchReportTotal(session, '10016', now - 86400, now);
    console.log('[Viewers] report 10016 raw:', JSON.stringify(data));

    if (isKSError(data)) {
      const retry = await handleKSError(session, data.code, () => fetchViewers(session));
      if (retry !== null) return retry;
      return 0;
    }

    if (!isServiceForbidden(data)) {
      const fields = parseReportTotal(data);
      console.log('[Viewers] report 10016 fields:', JSON.stringify(fields));
      const active = parseInt(fields['view_unique_combined_live_audience'] || '0', 10);
      if (active > 0) return active;
    }
  } catch (err) {
    console.log('[Viewers] report 10016 error:', err.message);
  }

  // Fallback: EP_WEBCAST_ENGAGEMENT (60003) — unique_combined_live_viewers
  try {
    const data = await fetchReportTotal(session, '60003', now - 86400, now);
    console.log('[Viewers] report 60003 raw:', JSON.stringify(data));

    if (!isKSError(data) && !isServiceForbidden(data)) {
      const fields = parseReportTotal(data);
      const viewers = parseInt(fields['unique_combined_live_viewers'] || '0', 10);
      if (viewers > 0) return viewers;
    }
  } catch (err) {
    console.log('[Viewers] report 60003 error:', err.message);
  }

  // Last fallback: liveReports ENTRY_TIME_LINE — audience graph
  try {
    const url = `${session.serviceUrl}/api_v3/service/liveReports/action/getEvents`;
    const params = new URLSearchParams({
      ks: session.currentKS,
      reportType: 'ENTRY_TIME_LINE',
      'filter[objectType]': 'KalturaLiveReportInputFilter',
      'filter[entryIds]': session.entryId,
      format: '1',
    });
    const { data } = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('[Viewers] liveReports ENTRY_TIME_LINE raw:', JSON.stringify(data));

    if (Array.isArray(data)) {
      const audienceGraph = data.find(g => g.id === 'audience');
      if (audienceGraph?.data) {
        // Data is semicolon-separated timestamp|value pairs; take the latest
        const points = audienceGraph.data.split(';').filter(Boolean);
        if (points.length > 0) {
          const lastPoint = points[points.length - 1];
          const value = parseInt(lastPoint.split('|')[1] || '0', 10);
          if (value > 0) return value;
        }
      }
    }
  } catch (err) {
    console.log('[Viewers] liveReports ENTRY_TIME_LINE error:', err.message);
  }

  return 0;
}

// ── Engagement Metrics (CnC) ────────────────────────────────────────────────
// Kaltura CnC reports chat/reactions/Q&A via the report service.
// EP_WEBCAST_LIVE_USER_ENGAGEMENT (60010) has all engagement fields:
//   count_group_chat_messages_sent, count_reaction_clicked, count_q_and_a_threads

// Per-session cache to avoid redundant API calls within the same poll tick
const _engagementCache = new Map();

async function fetchEngagementReport(session, fromDate, toDate) {
  const cacheKey = session.entryId;
  const cached = _engagementCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < 30000) {
    return cached.fields;
  }

  // Primary: EP_WEBCAST_LIVE_USER_ENGAGEMENT (60010) — has all CnC fields
  // Fallback: ENGAGEMENT_TOOLS_WEBCAST (40012) — has reactions but not chat
  for (const reportType of ['60010', '60003', '40012']) {
    try {
      const data = await fetchReportTotal(session, reportType, fromDate, toDate);
      console.log(`[Engagement] report ${reportType} raw:`, JSON.stringify(data));

      if (isKSError(data)) {
        await handleKSError(session, data.code, () => fetchEngagementReport(session, fromDate, toDate));
        return null;
      }
      if (isServiceForbidden(data)) continue;

      const fields = parseReportTotal(data);
      // Check if this report has meaningful engagement fields (not just empty headers)
      const hasData = Object.values(fields).some(v => v && v !== '0');
      if (hasData) {
        console.log(`[Engagement] using report ${reportType}:`, JSON.stringify(fields));
        _engagementCache.set(cacheKey, { fields, time: Date.now() });
        return fields;
      }
    } catch (err) {
      console.log(`[Engagement] report ${reportType} error:`, err.message);
    }
  }

  return null;
}

export async function fetchReactions(session, windowStart) {
  if (session.disabledServices.has('reactions')) return 0;

  const now = Math.floor(Date.now() / 1000);
  const fields = await fetchEngagementReport(session, windowStart, now);

  if (fields) {
    for (const key of ['count_reaction_clicked', 'reaction_clicked']) {
      if (fields[key] && parseInt(fields[key], 10) > 0) {
        return parseInt(fields[key], 10);
      }
    }
  }

  return 0;
}

export async function fetchChat(session, windowStart) {
  if (session.disabledServices.has('chat')) return 0;

  const now = Math.floor(Date.now() / 1000);
  const fields = await fetchEngagementReport(session, windowStart, now);

  if (fields) {
    for (const key of ['count_group_chat_messages_sent', 'count_group_message_sent',
                       'group_message_sent']) {
      if (fields[key] && parseInt(fields[key], 10) > 0) {
        return parseInt(fields[key], 10);
      }
    }
  }

  return 0;
}

export async function fetchQuestions(session, windowStart) {
  if (session.disabledServices.has('questions')) return 0;

  const now = Math.floor(Date.now() / 1000);
  const fields = await fetchEngagementReport(session, windowStart, now);

  if (fields) {
    for (const key of ['count_q_and_a_threads', 'count_qna', 'q_and_a']) {
      if (fields[key] && parseInt(fields[key], 10) > 0) {
        return parseInt(fields[key], 10);
      }
    }
  }

  return 0;
}

// ── Poll Tick ───────────────────────────────────────────────────────────────

export async function pollTick(session) {
  if (session.status === 'complete' || session.status === 'error') return;

  const tickStart = Date.now();
  // Look back from when monitoring started (cumulative count), not just the poll interval
  const monitoringStartSec = session.monitoringSince
    ? Math.floor(new Date(session.monitoringSince).getTime() / 1000)
    : Math.floor(tickStart / 1000) - 3600; // default: 1 hour lookback
  const windowStart = monitoringStartSec;

  // Refresh KS if needed (credentials mode only)
  try {
    await refreshKSIfNeeded(session);
  } catch (err) {
    console.log('[Poll] KS refresh failed:', err.message);
    // Continue with existing KS — individual fetchers will handle KS errors
  }

  const [viewers, reactions, chat, questions] = await Promise.allSettled([
    session.selectedMetrics.viewers ? fetchViewers(session) : Promise.resolve(null),
    session.selectedMetrics.reactions ? fetchReactions(session, windowStart) : Promise.resolve(null),
    session.selectedMetrics.chat ? fetchChat(session, windowStart) : Promise.resolve(null),
    session.selectedMetrics.questions ? fetchQuestions(session, windowStart) : Promise.resolve(null),
  ]);

  // If session was stopped/errored during async fetches, bail
  if (session.status === 'complete' || session.status === 'error') return;

  const snapshot = {
    timestamp: new Date().toISOString(),
    viewers: viewers.status === 'fulfilled' ? viewers.value : 0,
    reactions: reactions.status === 'fulfilled' ? reactions.value : 0,
    chat: chat.status === 'fulfilled' ? chat.value : 0,
    questions: questions.status === 'fulfilled' ? questions.value : 0,
  };

  session.previousMetrics = { ...session.latestMetrics };
  session.latestMetrics = snapshot;
  session.history.push(snapshot);
  session.dataPoints++;
  session.lastPoll = snapshot.timestamp;
  session.nextPollAt = new Date(Date.now() + session.pollIntervalMs).toISOString();

  console.log(
    `[Poll] ${snapshot.timestamp} | Viewers: ${snapshot.viewers} | Reactions: ${snapshot.reactions} | Chat: ${snapshot.chat} | Questions: ${snapshot.questions}`,
  );
}
