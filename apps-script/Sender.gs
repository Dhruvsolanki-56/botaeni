/**
 * Stage 5. IMPORTANT — deployment model: this file runs under WHICHEVER
 * Google account executes it, and sending always happens as that account.
 * To rotate across 2-3 Gmail accounts (plan §07), each sending account
 * needs its own copy of this Apps Script project bound to the SAME shared
 * Google Sheet (share the sheet with Editor access to each sending account,
 * then open it from Extensions > Apps Script in that account). Every
 * deployment reads the same SendQueue but each only sends the rows whose
 * assigned_sender matches the account it's running as.
 *
 * Set each sending Gmail account's forwarding to REPLY_TO_EMAIL
 * (adsolutions200@gmail.com) in Gmail Settings > Forwarding, so replies all
 * land in one inbox for ReplyHandler.gs to process centrally.
 *
 * Actual sending goes through sendProductionEmail_ (MimeMail.gs), which
 * adds a real List-Unsubscribe header when the Gmail advanced service is
 * enabled, and falls back to plain GmailApp.sendEmail otherwise.
 */
function sendQueue() {
  return withLock_('sendQueue', function () {
    if (!isWithinSendWindow_()) return { sent: 0, reason: 'outside_send_window' };

    const config = getConfig();
    const myEmail = Session.getActiveUser().getEmail();
    const alreadySentToday = countSentTodayBySender_(myEmail);
    if (alreadySentToday >= config.dailyCapPerSender) return { sent: 0, reason: 'daily_cap_reached' };

    const budget = createTimeBudget_(MAX_RUN_MS);
    const sheet = getSheet_(SHEETS.SEND_QUEUE);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { sent: 0, reason: 'queue_empty' };
    const idx = indexMap_(values[0]);
    let sentThisRun = 0;
    let cursor = alreadySentToday;

    for (let r = 1; r < values.length && cursor < config.dailyCapPerSender; r++) {
      if (budget.isExpired()) break;
      const row = values[r];
      if (row[idx.status] !== 'queued') continue;
      if (row[idx.assigned_sender] !== myEmail) continue;

      const email = row[idx.contact_email];
      const rowNumber = r + 1;
      if (isSuppressed_(email)) {
        setCell_(SHEETS.SEND_QUEUE, rowNumber, 'status', 'skipped_suppressed');
        continue;
      }

      try {
        sendProductionEmail_(email, row[idx.subject], row[idx.body], config);
        setCell_(SHEETS.SEND_QUEUE, rowNumber, 'status', 'sent');
        appendRow_(SHEETS.SENT_LOG, {
          lead_id: row[idx.lead_id], contact_email: email, sender: myEmail,
          subject: row[idx.subject], sequence_step: row[idx.sequence_step] || 1,
          sent_at: nowIso_(), status: 'sent'
        });
        sentThisRun++;
        cursor++;
        Utilities.sleep(3000 + Math.floor(Math.random() * 5000)); // jitter — no two sends land on the same second
      } catch (e) {
        setCell_(SHEETS.SEND_QUEUE, rowNumber, 'status', 'failed: ' + e.message.substring(0, 150));
        logError_('sendQueue', e, { lead_id: row[idx.lead_id], contact_email: email });
      }
    }
    return { sent: sentThisRun };
  });
}

function countSentTodayBySender_(senderEmail) {
  const rows = readSheetAsObjects_(SHEETS.SENT_LOG);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return rows.filter(function (r) {
    return r.sender === senderEmail && String(r.sent_at).slice(0, 10) === today;
  }).length;
}
