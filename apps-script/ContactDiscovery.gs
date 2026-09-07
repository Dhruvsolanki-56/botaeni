/**
 * Stage 3: find a real person + verified-enough email at each ICP-fit lead.
 * Uses Hunter.io's free tier (25 searches + 50 verifications/month) if
 * HUNTER_API_KEY is set. Without a key, leads are marked "manual_needed" so
 * you can fill contact_email by hand in the Contacts sheet — the rest of the
 * pipeline doesn't care how the email got there.
 */
function findContacts() {
  return withLock_('findContacts', function () {
    const config = getConfig();
    const budget = createTimeBudget_(MAX_RUN_MS);
    const classified = readSheetAsObjects_(SHEETS.CLASSIFIED);
    const existingContacts = new Set(readSheetAsObjects_(SHEETS.CONTACTS).map(function (r) { return r.lead_id; }));
    const rawByLeadId = {};
    readSheetAsObjects_(SHEETS.RAW_LEADS).forEach(function (r) { rawByLeadId[r.lead_id] = r; });

    const pending = classified.filter(function (c) {
      return Number(c.icp_fit_score) >= config.icpFitThreshold && !existingContacts.has(c.lead_id);
    });

    for (let i = 0; i < pending.length; i++) {
      if (budget.isExpired()) break;
      const lead = pending[i];
      const raw = rawByLeadId[lead.lead_id];
      if (!raw || !raw.website) continue;
      const domain = normalizeDomain_(raw.website);

      if (!config.hunterApiKey) {
        appendRow_(SHEETS.CONTACTS, {
          lead_id: lead.lead_id,
          contact_name: '',
          contact_title: lead.likely_decision_maker_title || '',
          contact_email: '',
          verification_status: 'manual_needed',
          source: 'none — HUNTER_API_KEY not set',
          found_at: nowIso_()
        });
        continue;
      }

      try {
        const found = huntDomain_(domain, lead.likely_decision_maker_title);
        appendRow_(SHEETS.CONTACTS, {
          lead_id: lead.lead_id,
          contact_name: found.name || '',
          contact_title: found.title || lead.likely_decision_maker_title || '',
          contact_email: found.email || '',
          verification_status: found.email ? (found.verification || 'unverified') : 'not_found',
          source: 'hunter.io',
          found_at: nowIso_()
        });
      } catch (e) {
        appendRow_(SHEETS.CONTACTS, {
          lead_id: lead.lead_id,
          contact_name: '', contact_title: lead.likely_decision_maker_title || '', contact_email: '',
          verification_status: 'lookup_failed: ' + e.message.substring(0, 150),
          source: 'hunter.io', found_at: nowIso_()
        });
        logError_('findContacts', e, { lead_id: lead.lead_id });
      }
      Utilities.sleep(800);
    }
  });
}

/** Hunter Domain Search — returns the best title match it can find, or the domain's generic pattern. */
function huntDomain_(domain, preferredTitle) {
  const apiKey = getConfig().hunterApiKey;
  const url = 'https://api.hunter.io/v2/domain-search?domain=' + encodeURIComponent(domain) + '&limit=10&api_key=' + apiKey;
  const response = fetchWithRetry_(url, { muteHttpExceptions: true }, 2);
  if (response.getResponseCode() !== 200) throw new Error('Hunter API error: ' + response.getContentText().substring(0, 300));
  const data = JSON.parse(response.getContentText()).data;
  const emails = data && data.emails ? data.emails : [];
  if (emails.length === 0) return {};

  const titleLower = (preferredTitle || '').toLowerCase();
  const best = emails.find(function (e) {
    return e.position && titleLower && e.position.toLowerCase().indexOf(titleLower.split(' ')[0]) !== -1;
  }) || emails.find(function (e) { return e.seniority === 'executive' || e.seniority === 'senior'; }) || emails[0];

  return {
    name: [best.first_name, best.last_name].filter(Boolean).join(' '),
    title: best.position || '',
    email: best.value || '',
    verification: best.verification && best.verification.status
  };
}
