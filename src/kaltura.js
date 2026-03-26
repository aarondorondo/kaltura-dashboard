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

export async function fetchViewers(session) {
  if (session.disabledServices.has('viewers')) return 0;

  // Primary: liveReports/getEvents with ENTRY_TOTAL
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
    console.log('[Viewers] liveReports/getEvents raw response:', JSON.stringify(data));

    if (isKSError(data)) {
      const retry = await handleKSError(session, data.code, () => fetchViewers(session));
      if (retry !== null) return retry;
      return 0;
    }

    if (!isServiceForbidden(data) && data?.objects?.length > 0) {
      const obj = data.objects[0];
      const count = obj.audience || obj.plays || obj.dve || 0;
      if (count > 0) return count;
    }
  } catch (err) {
    console.log('[Viewers] liveReports/getEvents error:', err.message);
  }

  // Fallback: report/getTotal with live report types
  for (const reportType of ['24', '10015']) {
    try {
      const url = `${session.serviceUrl}/api_v3/service/report/action/getTotal`;
      const now = Math.floor(Date.now() / 1000);
      const params = new URLSearchParams({
        ks: session.currentKS,
        format: '1',
        reportType,
        'reportInputFilter[objectType]': 'KalturaReportInputFilter',
        'reportInputFilter[entryIdIn]': session.entryId,
        'reportInputFilter[fromDate]': String(now - 300),
        'reportInputFilter[toDate]': String(now),
      });
      const { data } = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      console.log(`[Viewers] report/getTotal (type=${reportType}) raw response:`, JSON.stringify(data));

      if (isKSError(data)) {
        const retry = await handleKSError(session, data.code, () => fetchViewers(session));
        if (retry !== null) return retry;
        return 0;
      }

      if (isServiceForbidden(data)) continue;

      // Parse CSV-style response: header\ndata
      if (data?.header && data?.data) {
        const headers = data.header.split(',');
        const values = data.data.split(',');
        const viewerIdx = headers.findIndex(h =>
          /viewer|audience|unique/i.test(h)
        );
        if (viewerIdx >= 0) {
          const count = parseInt(values[viewerIdx], 10);
          if (count > 0) return count;
        }
        // Try first numeric value as fallback
        for (const v of values) {
          const n = parseInt(v, 10);
          if (n > 0) return n;
        }
      }
    } catch (err) {
      console.log(`[Viewers] report/getTotal (type=${reportType}) error:`, err.message);
    }
  }

  // Last resort: entry metadata plays count
  try {
    const url = `${session.serviceUrl}/api_v3/service/media/action/get`;
    const { data } = await axios.get(url, {
      params: { ks: session.currentKS, entryId: session.entryId, format: 1 },
    });
    if (data?.plays != null && data.plays > 0) {
      console.log(`[Viewers] media/get plays=${data.plays}, currentBroadcastStartTime=${data.currentBroadcastStartTime}`);
      return data.plays;
    }
  } catch (err) {
    console.log('[Viewers] media/get fallback error:', err.message);
  }

  return 0;
}

async function fetchCuepoints(session, tag, serviceKey, windowStart) {
  if (session.disabledServices.has(serviceKey)) return 0;

  // Try with KalturaCuePointFilter first (broader), then KalturaAnnotationFilter
  const filters = [
    { objectType: 'KalturaCuePointFilter', tagField: 'tagsLike' },
    { objectType: 'KalturaAnnotationFilter', tagField: 'tagsLike' },
  ];

  for (const filter of filters) {
    try {
      const url = `${session.serviceUrl}/api_v3/service/cuepoint_cuepoint/action/list`;
      const params = new URLSearchParams({
        ks: session.currentKS,
        format: '1',
        'filter[objectType]': filter.objectType,
        'filter[entryIdEqual]': session.entryId,
        [`filter[${filter.tagField}]`]: tag,
        'filter[createdAtGreaterThanOrEqual]': String(windowStart),
        'pager[pageSize]': '1',
      });

      const { data } = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      console.log(`[${serviceKey}] cuepoint/list (${filter.objectType}) raw response:`, JSON.stringify(data));

      if (isKSError(data)) {
        const retry = await handleKSError(session, data.code, () =>
          fetchCuepoints(session, tag, serviceKey, windowStart),
        );
        if (retry !== null) return retry;
        return 0;
      }

      if (isServiceForbidden(data)) {
        continue; // try next filter
      }

      if (data?.totalCount != null) {
        return data.totalCount;
      }
    } catch (err) {
      console.log(`[${serviceKey}] cuepoint/list (${filter.objectType}) error:`, err.message);
    }
  }

  // All filters failed
  session.disabledServices.add(serviceKey);
  const warning = `${serviceKey.charAt(0).toUpperCase() + serviceKey.slice(1)} API not available on this account (showing 0).`;
  if (!session.warnings.includes(warning)) session.warnings.push(warning);
  console.log(`[${serviceKey}] All cuepoint filters failed — disabled for this session`);
  return 0;
}

export async function fetchReactions(session, windowStart) {
  return fetchCuepoints(session, 'reaction', 'reactions', windowStart);
}

export async function fetchChat(session, windowStart) {
  return fetchCuepoints(session, 'chat', 'chat', windowStart);
}

export async function fetchQuestions(session, windowStart) {
  if (session.disabledServices.has('questions')) return 0;

  // Primary: tagsLike=question
  let primary = 0;
  let primaryOk = true;
  try {
    primary = await fetchCuepoints(session, 'question', '_questions_primary', windowStart);
  } catch {
    primaryOk = false;
  }
  if (session.disabledServices.has('_questions_primary')) {
    primaryOk = false;
    session.disabledServices.delete('_questions_primary');
  }

  // Fallback: cuePointTypeEqual=quiz.QUIZ_QUESTION
  let fallback = 0;
  let fallbackOk = true;
  try {
    const url = `${session.serviceUrl}/api_v3/service/cuepoint_cuepoint/action/list`;
    const params = new URLSearchParams({
      ks: session.currentKS,
      format: '1',
      'filter[objectType]': 'KalturaAnnotationFilter',
      'filter[entryIdEqual]': session.entryId,
      'filter[cuePointTypeEqual]': 'quiz.QUIZ_QUESTION',
      'filter[createdAtGreaterThanOrEqual]': String(windowStart),
      'pager[pageSize]': '1',
    });
    const { data } = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('[questions] quiz fallback raw response:', JSON.stringify(data));

    if (isKSError(data)) {
      await handleKSError(session, data.code, () => fetchQuestions(session, windowStart));
      return 0;
    }

    if (isServiceForbidden(data)) {
      fallbackOk = false;
    } else {
      fallback = data?.totalCount ?? 0;
    }
  } catch {
    fallbackOk = false;
  }

  if (!primaryOk && !fallbackOk) {
    session.disabledServices.add('questions');
    const warning = 'Questions API not available on this account (showing 0).';
    if (!session.warnings.includes(warning)) session.warnings.push(warning);
    console.log('[questions] Both endpoints failed — disabled for this session');
    return 0;
  }

  return Math.max(primary, fallback);
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
