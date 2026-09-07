/**
 * Stage 2 from the plan: work out what business this is, and whether it's
 * worth pitching. Reads RawLeads rows with status "new", writes one row per
 * lead into Classified, and flips RawLeads status to "classified" or
 * "classify_failed".
 */
function classifyLeads() {
  return withLock_('classifyLeads', function () {
    const config = getConfig();
    const budget = createTimeBudget_(MAX_RUN_MS);
    const raw = readSheetAsObjects_(SHEETS.RAW_LEADS);
    const pending = raw.filter(function (r) { return r.status === 'new'; });
    const alreadyClassified = new Set(readSheetAsObjects_(SHEETS.CLASSIFIED).map(function (r) { return r.lead_id; }));
    let processed = 0;

    for (let i = 0; i < pending.length; i++) {
      if (budget.isExpired()) break; // pick up the rest next run rather than risk a hard timeout mid-write
      const lead = pending[i];
      if (alreadyClassified.has(lead.lead_id)) {
        setCell_(SHEETS.RAW_LEADS, lead._rowNumber, 'status', 'classified');
        continue;
      }
      try {
        const pageText = fetchPageText_(lead.website, 3000);
        const inputText = [
          'Company name: ' + lead.company_name,
          'Website: ' + lead.website,
          'Category/tags: ' + lead.category,
          'Address: ' + lead.address,
          pageText ? 'Homepage text: ' + pageText : '(homepage could not be fetched — classify from the fields above only, and set confidence to low if that is not enough)'
        ].join('\n');

        const result = callGeminiJson_(buildClassificationPrompt_(inputText, config.icpDescription));
        appendRow_(SHEETS.CLASSIFIED, {
          lead_id: lead.lead_id,
          industry: result.industry || '',
          sub_vertical: result.sub_vertical || '',
          company_size_estimate: result.company_size_estimate || '',
          icp_fit_score: Number(result.icp_fit_score) || 0,
          likely_decision_maker_title: result.likely_decision_maker_title || '',
          pitch_angle: result.pitch_angle || '',
          evidence_snippet: result.evidence_snippet || '',
          confidence: result.confidence || 'low',
          classified_at: nowIso_()
        });
        setCell_(SHEETS.RAW_LEADS, lead._rowNumber, 'status', 'classified');
        processed++;
      } catch (e) {
        setCell_(SHEETS.RAW_LEADS, lead._rowNumber, 'status', 'classify_failed: ' + e.message.substring(0, 200));
        logError_('classifyLeads', e, { lead_id: lead.lead_id });
      }
      Utilities.sleep(1200); // stay well under Gemini free-tier rate limits
    }
    return { processed: processed, remaining: pending.length - processed };
  });
}

function buildClassificationPrompt_(inputText, icpDescription) {
  return [
    'You classify small/mid-size businesses from their own website text and',
    'public listing data. You never invent facts not present in the input.',
    'If the input is too thin to classify confidently, say so via the',
    'confidence field rather than guessing.',
    '',
    'Our ideal customer: ' + icpDescription,
    '',
    'INPUT:',
    inputText,
    '',
    'Return strict JSON with exactly these fields:',
    '{',
    '  "industry": "",',
    '  "sub_vertical": "",',
    '  "company_size_estimate": "solo | small (2-10) | mid (11-50) | larger",',
    '  "icp_fit_score": 0,',
    '  "likely_decision_maker_title": "",',
    '  "pitch_angle": "one sentence: why THIS service fits THIS business",',
    '  "evidence_snippet": "exact quote from the input backing the classification",',
    '  "confidence": "high | medium | low"',
    '}',
    'If confidence is "low", leave pitch_angle as an empty string rather than inventing one.'
  ].join('\n');
}
