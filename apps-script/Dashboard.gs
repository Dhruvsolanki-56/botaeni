/**
 * Server-side data for the dashboard (Dashboard.html-equivalent lives in
 * renderDashboardHtml_ below, served by WebApp.gs's doGet). Everything here
 * reads straight off the live sheets — there is no separate analytics
 * store, so the dashboard is never more than a few seconds stale.
 */
function getDashboardData() {
  const config = getConfig();
  const raw = readSheetAsObjects_(SHEETS.RAW_LEADS);
  const classified = readSheetAsObjects_(SHEETS.CLASSIFIED);
  const contacts = readSheetAsObjects_(SHEETS.CONTACTS);
  const drafts = readSheetAsObjects_(SHEETS.DRAFTS);
  const queue = readSheetAsObjects_(SHEETS.SEND_QUEUE);
  const sentLog = readSheetAsObjects_(SHEETS.SENT_LOG);
  const replies = readSheetAsObjects_(SHEETS.REPLIES);
  const suppression = readSheetAsObjects_(SHEETS.SUPPRESSION);
  const errors = readSheetAsObjects_(SHEETS.ERRORS);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const countBy = function (rows, field) {
    const out = {};
    rows.forEach(function (r) { const k = r[field] || 'unknown'; out[k] = (out[k] || 0) + 1; });
    return out;
  };

  const senderStats = config.senderAccounts.map(function (sender) {
    const sends = sentLog.filter(function (r) { return r.sender === sender; });
    const sendsToday = sends.filter(function (r) { return String(r.sent_at).slice(0, 10) === today; }).length;
    return { sender: sender, totalSent: sends.length, sentToday: sendsToday, dailyCap: config.dailyCapPerSender };
  });

  const icpScores = classified.map(function (c) { return Number(c.icp_fit_score) || 0; }).filter(function (n) { return n > 0; });
  const avgIcpScore = icpScores.length ? Math.round(icpScores.reduce(function (a, b) { return a + b; }, 0) / icpScores.length) : 0;

  const funnel = [
    { stage: 'Sourced', count: raw.length },
    { stage: 'Classified', count: classified.length },
    { stage: 'ICP fit', count: classified.filter(function (c) { return Number(c.icp_fit_score) >= config.icpFitThreshold; }).length },
    { stage: 'Contact found', count: contacts.filter(function (c) { return c.contact_email; }).length },
    { stage: 'Drafted', count: drafts.length },
    { stage: 'Approved', count: drafts.filter(function (d) { return d.status === 'approved'; }).length },
    { stage: 'Sent', count: sentLog.length },
    { stage: 'Replied', count: replies.length },
    { stage: 'Interested', count: replies.filter(function (r) { return r.category === 'interested'; }).length }
  ];

  const oneDayMs = 24 * 60 * 60 * 1000;
  const recentActivity = sentLog.map(function (r) {
    return { type: 'sent', at: r.sent_at, detail: r.contact_email + ' — ' + r.subject, meta: r.sender };
  }).concat(replies.map(function (r) {
    return { type: 'reply_' + r.category, at: r.received_at, detail: r.contact_email + ' — ' + r.snippet, meta: r.urgency };
  })).sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); }).slice(0, 40);

  return {
    generatedAt: nowIso_(),
    funnel: funnel,
    replyBreakdown: countBy(replies, 'category'),
    contactStatusBreakdown: countBy(contacts, 'verification_status'),
    draftStatusBreakdown: countBy(drafts, 'status'),
    queueStatusBreakdown: countBy(queue, 'status'),
    senderStats: senderStats,
    avgIcpScore: avgIcpScore,
    suppressionCount: suppression.length,
    errorCount24h: errors.filter(function (e) { return (Date.now() - new Date(e.timestamp).getTime()) < oneDayMs; }).length,
    totalErrors: errors.length,
    recentActivity: recentActivity,
    recentErrors: errors.slice(-15).reverse()
  };
}

/** Powers the "raw data" explorer — every sheet, most recent rows first. */
function getSheetRows(sheetName, limit) {
  if (Object.keys(HEADERS).indexOf(sheetName) === -1) throw new Error('Unknown sheet: ' + sheetName);
  const rows = readSheetAsObjects_(sheetName).map(function (r) { delete r._rowNumber; return r; });
  return { header: HEADERS[sheetName], sheetNames: Object.keys(HEADERS), rows: rows.slice(-(limit || 200)).reverse() };
}

/**
 * Dashboard "Run now" buttons — one whitelisted entry point instead of
 * exposing every pipeline function directly to google.script.run, so the
 * set of things a page load can trigger is explicit and reviewable in one
 * place. Every stage here is exactly what the timers already call; a manual
 * run and a scheduled one behave identically (same lock, same budget).
 */
function runPipelineStage(stageName) {
  switch (stageName) {
    case 'sourceLeads': return autoSourceLeads();
    case 'normalize': return normalizeRawLeads();
    case 'classify': return classifyLeads();
    case 'findContacts': return findContacts();
    case 'draftEmails': return draftEmails();
    case 'queueApproved': return queueApprovedDrafts();
    case 'sendQueue': return sendQueue();
    case 'checkReplies': return checkReplies();
    default: throw new Error('Unknown pipeline stage: ' + stageName);
  }
}
