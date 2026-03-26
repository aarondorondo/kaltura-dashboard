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

  // Primary: HIGHLIGHTS_WEBCAST (40001) — use wider window (1 hour) for viewer data
  // Also try with the full session duration for cumulative unique viewers
  const windows = [
    { from: now - 3600, to: now, label: '1h' },
    { from: now - 86400, to: now, label: '24h' },
  ];

  for (const window of windows) {
    for (const reportType of ['40001', '60001']) {
      try {
        const data = await fetchReportTotal(session, reportType, window.from, window.to);
        console.log(`[Viewers] report/getTotal (type=${reportType}, window=${window.label}) raw:`, JSON.stringify(data));

        if (isKSError(data)) {
          const retry = await handleKSError(session, data.code, () => fetchViewers(session));
          if (retry !== null) return retry;
          return 0;
        }
        if (isServiceForbidden(data)) continue;

        const fields = parseReportTotal(data);
        console.log(`[Viewers] report fields (${window.label}):`, JSON.stringify(fields));

        // Look for viewer count fields
        for (const key of ['live_view_period_count', 'combined_live_view_period_count',
                           'count_viewers', 'unique_viewers', 'unique_known_users',
                           'count_loads', 'count_plays']) {
          if (fields[key] && parseInt(fields[key], 10) > 0) {
            return parseInt(fields[key], 10);
          }
        }

        // If sum_live_view_period exists, estimate viewers from avg view time
        // sum_live_view_period / avg_time ≈ viewer count
        if (fields['sum_live_view_period'] && parseFloat(fields['sum_live_view_period']) > 0) {
          const sumViewPeriod = parseFloat(fields['sum_live_view_period']);
          const avgViewPeriod = parseFloat(fields['combined_live_avg_play_time'] || fields['avg_view_period'] || '0');
          if (avgViewPeriod > 0) {
            const estimated = Math.round(sumViewPeriod / avgViewPeriod);
            console.log(`[Viewers] Estimated from sum/avg: ${sumViewPeriod}/${avgViewPeriod} = ${estimated}`);
            if (estimated > 0) return estimated;
          }
        }
      } catch (err) {
        console.log(`[Viewers] report/getTotal (type=${reportType}, window=${window.label}) error:`, err.message);
      }
    }
  }

  // Fallback: liveReports/getEvents ENTRY_TOTAL
  try {
    const url = `${session.serviceUrl}/api_v3/service/liveReports/action/getEvents`;
    const params = new URLSearchParams({
      ks: session.currentKS,
      reportType: 'ENTRY_TOTAL',
      'filter[objectType]': 'KalturaLiveReportInputFilter',
      'filter[entryIds]': session.entryId,
      format: '1',
    });
    const { data } = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('[Viewers] liveReports/getEvents raw:', JSON.stringify(data));

    if (isKSError(data)) {
      const retry = await handleKSError(session, data.code, () => fetchViewers(session));
      if (retry !== null) return retry;
      return 0;
    }

    if (!isServiceForbidden(data) && data?.objects?.length > 0) {
      const obj = data.objects[0];
      const count = obj.audience || obj.plays || 0;
      if (count > 0) return count;
    }
  } catch (err) {
    console.log('[Viewers] liveReports/getEvents error:', err.message);
  }

  return 0;
}

// ── Engagement Metrics (CnC) ────────────────────────────────────────────────
// Kaltura CnC stores chat/reactions/Q&A in the report service, not cuepoints.
// We fetch ENGAGEMENT_TOOLS_WEBCAST (40012) or EP equivalent (60003) which
// returns totals for all engagement tools in one call.

let _lastEngagementData = null;
let _lastEngagementFetchTime = 0;

async function fetchEngagementReport(session, fromDate, toDate) {
  // Cache for 30s to avoid redundant calls (chat/reactions/questions all need this)
  const now = Date.now();
  if (_lastEngagementData && (now - _lastEngagementFetchTime) < 30000) {
    return _lastEngagementData;
  }

  // Try webcast engagement tools report types
  for (const reportType of ['40012', '60003', '40001', '60001']) {
    try {
      const data = await fetchReportTotal(session, reportType, fromDate, toDate);
      console.log(`[Engagement] report/getTotal (type=${reportType}) raw:`, JSON.stringify(data));

      if (isKSError(data)) {
        await handleKSError(session, data.code, () => fetchEngagementReport(session, fromDate, toDate));
        return null;
      }
      if (isServiceForbidden(data)) continue;

      const fields = parseReportTotal(data);
      if (Object.keys(fields).length > 0) {
        console.log(`[Engagement] report fields (type=${reportType}):`, JSON.stringify(fields));
        _lastEngagementData = fields;
        _lastEngagementFetchTime = now;
        return fields;
      }
    } catch (err) {
      console.log(`[Engagement] report/getTotal (type=${reportType}) error:`, err.message);
    }
  }

  return null;
}

export async function fetchReactions(session, windowStart) {
  if (session.disabledServices.has('reactions')) return 0;

  const now = Math.floor(Date.now() / 1000);
  const fields = await fetchEngagementReport(session, windowStart, now);

  if (fields) {
    // Look for reaction-related fields
    for (const key of ['count_reaction_clicked', 'reaction_clicked',
                       'reactions', 'total_reactions', 'count_reactions']) {
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
    // Look for chat-related fields
    for (const key of ['count_group_message_sent', 'group_message_sent',
                       'chat_messages', 'total_chat_messages', 'count_chat_messages']) {
      if (fields[key] && parseInt(fields[key], 10) > 0) {
        return parseInt(fields[key], 10);
      }
    }
  }

  // Fallback: try TOP_USERS_WEBCAST (40009) getTable — has per-user chat counts
  try {
    const url = `${session.serviceUrl}/api_v3/service/report/action/getTable`;
    const params = new URLSearchParams({
      ks: session.currentKS,
      format: '1',
      reportType: '40009',
      'reportInputFilter[objectType]': 'KalturaReportInputFilter',
      'reportInputFilter[entryIdIn]': session.entryId,
      'reportInputFilter[fromDate]': String(windowStart),
      'reportInputFilter[toDate]': String(now),
      'pager[pageSize]': '500',
      'pager[pageIndex]': '1',
    });
    const { data } = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('[Chat] report/getTable (type=40009) raw:', JSON.stringify(data));

    if (!isKSError(data) && !isServiceForbidden(data) && data?.header && data?.data) {
      const headers = data.header.split(',');
      const chatIdx = headers.findIndex(h =>
        /chat|message_sent|group_message/i.test(h)
      );
      if (chatIdx >= 0) {
        // Sum across all users (rows separated by ;)
        const rows = data.data.split(';');
        let total = 0;
        for (const row of rows) {
          const vals = row.split(',');
          total += parseInt(vals[chatIdx] || '0', 10);
        }
        if (total > 0) return total;
      }
    }
  } catch (err) {
    console.log('[Chat] report/getTable (type=40009) error:', err.message);
  }

  return 0;
}

export async function fetchQuestions(session, windowStart) {
  if (session.disabledServices.has('questions')) return 0;

  const now = Math.floor(Date.now() / 1000);
  const fields = await fetchEngagementReport(session, windowStart, now);

  if (fields) {
    // Look for Q&A-related fields
    for (const key of ['count_qna', 'qna', 'questions', 'total_questions',
                       'count_questions', 'q_and_a']) {
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
