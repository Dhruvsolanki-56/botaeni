/**
 * Two ways to fill RawLeads, both land in the same sheet:
 *
 * 1) Manual (works for MCA / Udyam / GST / IndiaMART / JustDial exports —
 *    none of those have a clean free API, so paste rows straight into the
 *    RawLeads tab yourself: source, company_name, website, category,
 *    address, phone. Leave lead_id, added_at and status blank and run
 *    normalizeRawLeads() to fill them in.
 *
 * 2) importLeadsFromPlaces() — pulls from Google Places API (Text Search),
 *    for markets/categories where Google Maps has good coverage. Needs a
 *    PLACES_API_KEY script property from a Google Cloud project (the $200/mo
 *    standing free credit covers this at small scale).
 */

function normalizeRawLeads() {
  const sheet = getSheet_(SHEETS.RAW_LEADS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const idx = indexMap_(values[0]);
  let updated = 0;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row[idx.company_name] === '' && row[idx.website] === '') continue;
    if (!row[idx.lead_id]) {
      sheet.getRange(r + 1, idx.lead_id + 1).setValue(generateLeadId_(row[idx.company_name], row[idx.website]));
      updated++;
    }
    if (!row[idx.added_at]) sheet.getRange(r + 1, idx.added_at + 1).setValue(nowIso_());
    if (!row[idx.status]) sheet.getRange(r + 1, idx.status + 1).setValue('new');
    if (!row[idx.source]) sheet.getRange(r + 1, idx.source + 1).setValue('manual');
  }
  Logger.log('Normalized ' + updated + ' new lead(s).');
}

function importLeadsFromPlaces(query, regionBias) {
  const apiKey = getProp_('PLACES_API_KEY', '');
  if (!apiKey) throw new Error('PLACES_API_KEY script property not set — see comment at top of Sourcing.gs.');
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const response = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.formattedAddress,places.internationalPhoneNumber,places.types'
    },
    payload: JSON.stringify({ textQuery: query, regionCode: regionBias || undefined }),
    muteHttpExceptions: true
  }, 2);
  if (response.getResponseCode() !== 200) {
    throw new Error('Places API error: ' + response.getContentText().substring(0, 500));
  }
  const data = JSON.parse(response.getContentText());
  const places = data.places || [];
  let added = 0;
  places.forEach(function (place) {
    if (!place.websiteUri) return; // no site to classify against, skip
    appendRow_(SHEETS.RAW_LEADS, {
      lead_id: generateLeadId_(place.displayName && place.displayName.text, place.websiteUri),
      source: 'google_places',
      company_name: place.displayName ? place.displayName.text : '',
      website: place.websiteUri,
      category: (place.types || []).slice(0, 3).join(', '),
      address: place.formattedAddress || '',
      phone: place.internationalPhoneNumber || '',
      added_at: nowIso_(),
      status: 'new'
    });
    added++;
  });
  Logger.log('Imported ' + added + ' lead(s) for query: ' + query);
}
