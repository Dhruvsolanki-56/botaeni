/**
 * Stage 6. Runs centrally under REPLY_TO_EMAIL's own account (that's where
 * every sending account forwards replies to). Scans for messages from
 * anyone we've ever emailed, classifies new ones, and routes: interested ->
 * notify you; not_interested/unsubscribe -> suppress immediately.
 */
function checkReplies() {
  return withLock_('checkReplies', function () {
    const sentLog = readSheetAsObjects_(SHEETS.SENT_LOG);
    if (sentLog.length === 0) return { processed: 0 };

    const budget = createTimeBudget_(MAX_RUN_MS);
    const contactedEmails = Array.from(new Set(sentLog.map(function (r) { return r.contact_email; }).filter(Boolean)));
    const leadIdByEmail = {};
    sentLog.forEach(function (r) { leadIdByEmail[r.contact_email] = r.lead_id; });

    const alreadyProcessed = new Set(readSheetAsObjects_(SHEETS.REPLIES).map(function (r) { return r.message_id; }));
    let processed = 0;

    outer:
    for (let e = 0; e < contactedEmails.length; e++) {
      if (budget.isExpired()) break;
      const email = contactedEmails[e];
      const threads = GmailApp.search('from:(' + email + ') newer_than:45d');
      for (let t = 0; t < threads.length; t++) {
        if (budget.isExpired()) break outer;
        const messages = threads[t].getMessages();
        for (let m = 0; m < messages.length; m++) {
          const message = messages[m];
          const id = message.getId();
          if (alreadyProcessed.has(id) || message.isDraft()) continue;

          const text = message.getPlainBody().substring(0, 3000);
          let classification;
          try {
            classification = classifyReply_(text);
          } catch (err) {
            logError_('checkReplies', err, { message_id: id });
            continue;
          }

          appendRow_(SHEETS.REPLIES, {
            lead_id: leadIdByEmail[email] || '',
            contact_email: email,
            message_id: id,
            received_at: message.getDate().toISOString(),
            snippet: text.substring(0, 300),
            category: classification.category || 'unknown',
            urgency: classification.urgency || '',
            suggested_action: classification.suggested_action || '',
            key_question_or_objection: classification.key_question_or_objection || ''
          });
          alreadyProcessed.add(id);
          processed++;

          if (classification.category === 'not_interested' || classification.category === 'unsubscribe') {
            addSuppression_(email, classification.category);
          }
          if (classification.category === 'interested') {
            notifyInterestedReply_(email, classification, text);
          }
        }
      }
    }
    return { processed: processed };
  });
}

function classifyReply_(replyText) {
  const prompt = [
    'Classify this email reply into exactly one category and extract',
    'next-step intent.',
    '',
    'INPUT: ' + replyText,
    '',
    'Return strict JSON with exactly these fields:',
    '{',
    '  "category": "interested | question_or_objection | not_now | not_interested | unsubscribe | out_of_office | wrong_person",',
    '  "urgency": "high | medium | low",',
    '  "suggested_action": "",',
    '  "key_question_or_objection": ""',
    '}',
    'Leave key_question_or_objection as an empty string unless category is question_or_objection.'
  ].join('\n');
  return callGeminiJson_(prompt);
}

function notifyInterestedReply_(email, classification, replyText) {
  const config = getConfig();
  GmailApp.sendEmail(
    config.notifyEmail,
    'Interested reply: ' + email,
    [
      'Category: ' + classification.category + ' (urgency: ' + classification.urgency + ')',
      'Suggested action: ' + classification.suggested_action,
      '',
      'Reply text:',
      replyText.substring(0, 1500)
    ].join('\n')
  );
}
