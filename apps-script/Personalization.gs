/**
 * Stage 4: turn one classified, contacted lead into a draft email. Every
 * draft lands in Drafts with status "pending_review" — nothing here ever
 * sends. A human (you) reviews and flips status to "approved" or "rejected"
 * directly in the sheet; queueApprovedDrafts() picks up the approved ones.
 */
function draftEmails() {
  return withLock_('draftEmails', function () {
    const config = getConfig();
    const budget = createTimeBudget_(MAX_RUN_MS);
    const classified = readSheetAsObjects_(SHEETS.CLASSIFIED);
    const contacts = readSheetAsObjects_(SHEETS.CONTACTS);
    const existingDrafts = new Set(readSheetAsObjects_(SHEETS.DRAFTS).map(function (r) { return r.lead_id; }));
    const classifiedById = {};
    classified.forEach(function (c) { classifiedById[c.lead_id] = c; });

    const pending = contacts.filter(function (c) {
      return c.contact_email && !isSuppressed_(c.contact_email) && !existingDrafts.has(c.lead_id);
    });

    for (let i = 0; i < pending.length; i++) {
      if (budget.isExpired()) break;
      const contact = pending[i];
      const lead = classifiedById[contact.lead_id];
      if (!lead || !lead.pitch_angle) continue; // low-confidence classification with no pitch_angle: skip, don't guess

      try {
        const opener = generateOpener_(lead);
        if (opener === 'INSUFFICIENT_SIGNAL') continue; // no real fact to hang an email on yet — skip rather than send generic filler

        const subject = 'Quick one about ' + (lead.sub_vertical || lead.industry || 'your team');
        const body = buildEmailBody_(contact, opener, lead, config);
        appendRow_(SHEETS.DRAFTS, {
          lead_id: contact.lead_id,
          contact_email: contact.contact_email,
          subject: subject,
          body: body,
          status: 'pending_review',
          created_at: nowIso_(),
          reviewed_at: ''
        });
      } catch (e) {
        logError_('draftEmails', e, { lead_id: contact.lead_id });
      }
      Utilities.sleep(1200);
    }
  });
}

function generateOpener_(lead) {
  const prompt = [
    'Write a single opening line (max 25 words) for a cold email.',
    'You may ONLY reference facts that appear verbatim or as a close',
    'paraphrase of the evidence snippet below. Never invent achievements,',
    'growth, or compliments not supported by it. If the snippet is too thin',
    'or generic to write something genuinely specific, respond with exactly',
    'the text INSUFFICIENT_SIGNAL and nothing else.',
    '',
    'evidence_snippet: ' + lead.evidence_snippet,
    'pitch_angle: ' + lead.pitch_angle,
    '',
    'Write ONE sentence, conversational, like someone who actually looked at',
    'their site — not "I noticed you are a leader in X" template phrasing.',
    'Output only the sentence (or INSUFFICIENT_SIGNAL), no quotes, no preamble.'
  ].join('\n');
  return callGemini_(prompt).trim().replace(/^["']|["']$/g, '');
}

function buildEmailBody_(contact, opener, lead, config) {
  const firstName = (contact.contact_name || '').split(' ')[0] || 'there';
  const ask = 'Worth a quick 15-minute look?';
  return [
    'Hi ' + firstName + ',',
    '',
    opener,
    '',
    lead.pitch_angle,
    '',
    ask,
    '',
    config.businessName
  ].join('\n');
}

/** Moves human-approved drafts (status="approved") into SendQueue, round-robining across SENDER_ACCOUNTS. */
function queueApprovedDrafts() {
  return withLock_('queueApprovedDrafts', function () {
    const config = getConfig();
    if (config.senderAccounts.length === 0) throw new Error('SENDER_ACCOUNTS script property not set.');
    const drafts = readSheetAsObjects_(SHEETS.DRAFTS);
    const alreadyQueued = new Set(readSheetAsObjects_(SHEETS.SEND_QUEUE).map(function (r) { return r.lead_id; }));
    let counter = Number(getProp_('_SENDER_ROUND_ROBIN_COUNTER', '0'));

    drafts
      .filter(function (d) { return d.status === 'approved' && !alreadyQueued.has(d.lead_id) && !isSuppressed_(d.contact_email); })
      .forEach(function (draft) {
        const sender = config.senderAccounts[counter % config.senderAccounts.length];
        counter++;
        appendRow_(SHEETS.SEND_QUEUE, {
          lead_id: draft.lead_id,
          contact_email: draft.contact_email,
          subject: draft.subject,
          body: draft.body,
          assigned_sender: sender,
          sequence_step: 1,
          status: 'queued',
          queued_at: nowIso_()
        });
        setCell_(SHEETS.DRAFTS, draft._rowNumber, 'reviewed_at', nowIso_());
      });

    PropertiesService.getScriptProperties().setProperty('_SENDER_ROUND_ROBIN_COUNTER', String(counter));
  });
}

/** Dashboard-facing: drafts still awaiting a human decision. */
function listPendingDrafts() {
  return readSheetAsObjects_(SHEETS.DRAFTS).filter(function (d) { return d.status === 'pending_review'; });
}

/** Dashboard "Approve"/"Reject" buttons — the only two decisions a human ever makes here; queueApprovedDrafts() picks up approved ones on its own schedule (or via the dashboard's "Send now" button). */
function setDraftStatus(rowNumber, status) {
  if (status !== 'approved' && status !== 'rejected') throw new Error('status must be "approved" or "rejected", got: ' + status);
  setCell_(SHEETS.DRAFTS, rowNumber, 'status', status);
  setCell_(SHEETS.DRAFTS, rowNumber, 'reviewed_at', nowIso_());
  return listPendingDrafts();
}
