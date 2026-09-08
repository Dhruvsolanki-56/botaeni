/**
 * Three ways to fill RawLeads, all land in the same sheet:
 *
 * 1) Manual (works for MCA / Udyam / GST / IndiaMART / JustDial exports —
 *    none of those have a clean free API, so paste rows straight into the
 *    RawLeads tab yourself: source, company_name, website, category,
 *    address, phone. Leave lead_id, added_at and status blank and run
 *    normalizeRawLeads() to fill them in.
 *
 * 2) importLeadsFromPlaces() — pulls from Google Places API (Text Search),
 *    for markets/categories where Google Maps has good coverage. Needs a
 *    PLACES_API_KEY script property from a Google Cloud project, and Google
 *    now gates that behind a billing account on file (the $200/mo standing
 *    free credit covers it at small scale, but a card is required) — skip
 *    this one if that's a blocker, same as the Gemini situation in Groq.gs.
 *
 * 3) autoSourceLeads() — fully automatic, genuinely free, no API key and no
 *    card, ever. Uses OpenStreetMap: Nominatim to resolve a place name to an
 *    area, then Overpass to list businesses tagged in that area. Configure
 *    what to look for ONCE in the SourceQueries sheet (category, osm_tag,
 *    location — see the three columns' comments below), wire it to a
 *    trigger (installCentralTriggers()/installAllTriggersSingleAccount() in
 *    Triggers.gs both do this already), and it runs unattended from there,
 *    advancing one query per run so every configured row gets covered over
 *    time. Coverage is patchier than Google Places (OSM's business tagging
 *    is crowdsourced and thinner in many areas), but it costs nothing and
 *    needs no signup. Example osm_tag values: amenity=restaurant,
 *    amenity=cafe, amenity=dentist, shop=bakery, shop=clothes, shop=beauty,
 *    leisure=fitness_centre, office=real_estate_agent — see
 *    wiki.openstreetmap.org/wiki/Map_features for the full tag list. A
 *    result needs both a name and a website tag to be added — the rest of
 *    the pipeline (findContacts especially) can't do anything with a lead
 *    that has no domain to work from.
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

/**
 * Picks the least-recently-run row in SourceQueries (never-run rows first),
 * resolves its location to an OSM area once (cached in the area_id column
 * after the first successful run), pulls matching businesses from Overpass,
 * and appends the ones with both a name and a website as new RawLeads rows.
 * One query per call by design — cheap, polite to the free OSM servers, and
 * self-healing: a row that errors still gets its last_run_at bumped, so a
 * persistent failure doesn't block every other row from ever running.
 */
function autoSourceLeads() {
  return withLock_('autoSourceLeads', function () {
    const sheet = getSheet_(SHEETS.SOURCE_QUERIES);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { found: 0, reason: 'no_queries_configured' };
    const idx = indexMap_(values[0]);

    let targetRow = -1;
    let oldestRun = null;
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (!row[idx.category] || !row[idx.osm_tag] || !row[idx.location]) continue;
      if (isSourceQueryDisabled_(row, idx)) continue;
      const lastRun = row[idx.last_run_at] ? new Date(row[idx.last_run_at]) : new Date(0);
      if (oldestRun === null || lastRun < oldestRun) {
        oldestRun = lastRun;
        targetRow = r;
      }
    }
    if (targetRow === -1) return { found: 0, reason: 'no_queries_configured' };

    return processSourceQueryRow_(idx, values[targetRow], targetRow + 1);
  });
}

/** The dashboard's per-row "Run now" button — forces one specific row immediately, ignoring the least-recently-run order (but not the enabled flag). */
function runSourceQueryNow(rowNumber) {
  return withLock_('autoSourceLeads', function () {
    const sheet = getSheet_(SHEETS.SOURCE_QUERIES);
    const values = sheet.getDataRange().getValues();
    const idx = indexMap_(values[0]);
    const row = values[rowNumber - 1];
    if (!row) throw new Error('No SourceQueries row at ' + rowNumber + '.');
    if (!row[idx.category] || !row[idx.osm_tag] || !row[idx.location]) {
      throw new Error('Row ' + rowNumber + ' is missing category/osm_tag/location.');
    }
    if (isSourceQueryDisabled_(row, idx)) throw new Error('Row ' + rowNumber + ' is disabled — enable it first.');
    return processSourceQueryRow_(idx, row, rowNumber);
  });
}

function isSourceQueryDisabled_(row, idx) {
  if (idx.enabled === undefined) return false;
  return String(row[idx.enabled] || '').trim().toUpperCase() === 'FALSE';
}

function processSourceQueryRow_(idx, row, rowNumber) {
  const category = row[idx.category];
  const osmTag = row[idx.osm_tag];
  const location = row[idx.location];

  try {
    let areaId = row[idx.area_id];
    if (!areaId) {
      areaId = geocodeAreaId_(location);
      setCell_(SHEETS.SOURCE_QUERIES, rowNumber, 'area_id', areaId);
    }

    const elements = queryOverpass_(osmTag, areaId);
    const existingDomains = existingLeadDomains_();
    let added = 0;
    elements.forEach(function (el) {
      const tags = el.tags || {};
      const name = tags.name;
      const website = tags.website || tags['contact:website'];
      if (!name || !website) return; // no domain to classify or find a contact against
      const domain = normalizeDomain_(website);
      if (!domain || existingDomains.has(domain)) return;
      existingDomains.add(domain);
      appendRow_(SHEETS.RAW_LEADS, {
        lead_id: generateLeadId_(name, website),
        source: 'osm',
        company_name: name,
        website: website,
        category: category,
        address: formatOsmAddress_(tags, location),
        phone: tags.phone || tags['contact:phone'] || '',
        added_at: nowIso_(),
        status: 'new'
      });
      added++;
    });

    setCell_(SHEETS.SOURCE_QUERIES, rowNumber, 'last_run_at', nowIso_());
    setCell_(SHEETS.SOURCE_QUERIES, rowNumber, 'total_found', Number(row[idx.total_found] || 0) + added);
    Logger.log('autoSourceLeads: found ' + added + ' new lead(s) for "' + category + '" in ' + location + '.');
    return { found: added, category: category, location: location };
  } catch (e) {
    setCell_(SHEETS.SOURCE_QUERIES, rowNumber, 'last_run_at', nowIso_());
    logError_('autoSourceLeads', e, { category: category, location: location });
    return { found: 0, error: e.message };
  }
}

/** Dashboard-facing: every configured target, with row numbers so the UI can edit/toggle/delete a specific one. */
function listSourceQueries() {
  return readSheetAsObjects_(SHEETS.SOURCE_QUERIES);
}

/** Dashboard "Add target" form. */
function addSourceQuery(category, osmTag, location) {
  category = (category || '').toString().trim();
  osmTag = (osmTag || '').toString().trim();
  location = (location || '').toString().trim();
  if (!category || !osmTag || !location) throw new Error('category, osm_tag, and location are all required.');
  appendRow_(SHEETS.SOURCE_QUERIES, { category: category, osm_tag: osmTag, location: location, enabled: 'TRUE' });
  return listSourceQueries();
}

/** Dashboard per-row enable/disable toggle. */
function setSourceQueryEnabled(rowNumber, enabled) {
  setCell_(SHEETS.SOURCE_QUERIES, rowNumber, 'enabled', enabled ? 'TRUE' : 'FALSE');
  return listSourceQueries();
}

/** Dashboard bulk "target all" / "pause all" buttons. */
function setAllSourceQueriesEnabled(enabled) {
  const sheet = getSheet_(SHEETS.SOURCE_QUERIES);
  const values = sheet.getDataRange().getValues();
  const idx = indexMap_(values[0]);
  if (idx.enabled !== undefined) {
    for (let r = 1; r < values.length; r++) {
      if (!values[r][idx.category]) continue;
      sheet.getRange(r + 1, idx.enabled + 1).setValue(enabled ? 'TRUE' : 'FALSE');
    }
  }
  return listSourceQueries();
}

/** Dashboard "remove target" button. */
function deleteSourceQueryRow(rowNumber) {
  getSheet_(SHEETS.SOURCE_QUERIES).deleteRow(rowNumber);
  return listSourceQueries();
}

function existingLeadDomains_() {
  const rows = readSheetAsObjects_(SHEETS.RAW_LEADS);
  const domains = new Set();
  rows.forEach(function (r) { if (r.website) domains.add(normalizeDomain_(r.website)); });
  return domains;
}

/**
 * Nominatim (OpenStreetMap's free geocoder) — resolves a place name to an
 * Overpass area id. Asks for several candidates rather than just the top
 * one: Nominatim's top match for a city name is often a point (a landmark
 * or the city's center node), not the administrative boundary Overpass
 * needs as an "area" — so this picks the first candidate that actually has
 * one (a relation or way) instead of failing on a technically-correct but
 * useless top result.
 */
function geocodeAreaId_(location) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(location);
  const response = fetchWithRetry_(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'LeadGenAutopilot (Google Apps Script; free-tier lead sourcing)' }
  }, 2);
  if (response.getResponseCode() !== 200) throw new Error('Nominatim error ' + response.getResponseCode() + ' for location: ' + location);
  const results = JSON.parse(response.getContentText());
  if (!results.length) throw new Error('Nominatim found no match for location: ' + location);
  const areaResult = results.find(function (r) { return r.osm_type === 'relation' || r.osm_type === 'way'; });
  if (!areaResult) {
    throw new Error('"' + location + '" only resolved to point results, not an area — try a more specific or more well-known place name (e.g. add the district/state/country).');
  }
  const offset = areaResult.osm_type === 'relation' ? 3600000000 : 2400000000;
  Utilities.sleep(1000); // Nominatim usage policy: max one request per second
  return offset + Number(areaResult.osm_id);
}

/**
 * Overpass API — lists nodes/ways carrying the given "key=value" tag inside
 * the resolved area. The main overpass-api.de instance is shared by every
 * Overpass user on the internet and occasionally answers a plain request
 * with an unhelpful error (a bare 406, a timeout) that has nothing to do
 * with the query itself — so this tries a couple of independently-run
 * mirrors in order rather than failing the whole run on the first one's bad
 * day. All three mirrors serve the same public OSM database.
 */
var OVERPASS_MIRRORS_ = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter'];

function queryOverpass_(osmTag, areaId) {
  const parts = osmTag.split('=').map(function (s) { return s.trim(); });
  const key = parts[0];
  const value = parts[1];
  const filter = value ? '["' + key + '"="' + value + '"]' : '["' + key + '"]';
  const query = '[out:json][timeout:25];area(' + areaId + ')->.a;' +
    '(node' + filter + '(area.a);way' + filter + '(area.a););' +
    'out tags 80;';

  let lastError;
  for (let i = 0; i < OVERPASS_MIRRORS_.length; i++) {
    try {
      const response = fetchWithRetry_(OVERPASS_MIRRORS_[i], {
        method: 'post',
        payload: { data: query },
        muteHttpExceptions: true
      }, 1);
      if (response.getResponseCode() !== 200) {
        lastError = new Error('Overpass error ' + response.getResponseCode() + ': ' + response.getContentText().substring(0, 300));
        continue;
      }
      const data = JSON.parse(response.getContentText());
      return data.elements || [];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function formatOsmAddress_(tags, fallbackLocation) {
  const parts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'] || tags['addr:suburb'], tags['addr:postcode']].filter(Boolean);
  return parts.length ? parts.join(', ') : fallbackLocation;
}
