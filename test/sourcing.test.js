'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

test('normalizeRawLeads fills lead_id, added_at, status and source only where blank', () => {
  const { context } = createEnv();
  context.setupSheets();
  context.appendRow_('RawLeads', { company_name: 'Acme Bakery', website: 'acmebakery.com', category: 'bakery', address: '', phone: '' });
  context.appendRow_('RawLeads', { company_name: 'Bravo Co', website: 'bravo.com', source: 'google_places', added_at: '2020-01-01', status: 'new' });

  context.normalizeRawLeads();

  const rows = context.readSheetAsObjects_('RawLeads');
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].status, 'new');
  assert.ok(rows[0].lead_id.length > 0);
  assert.equal(rows[1].source, 'google_places', 'should not overwrite an already-set source');
  assert.equal(rows[1].added_at, '2020-01-01', 'should not overwrite an already-set added_at');
});

test('normalizeRawLeads ignores fully blank rows', () => {
  const { context } = createEnv();
  context.setupSheets();
  context.getSheet_('RawLeads').appendRow(['', '', '', '', '', '', '', '', '']);

  assert.doesNotThrow(() => context.normalizeRawLeads());
  assert.equal(context.readSheetAsObjects_('RawLeads')[0].lead_id, '');
});

test('importLeadsFromPlaces requires PLACES_API_KEY', () => {
  const { context } = createEnv();
  context.setupSheets();
  assert.throws(() => context.importLeadsFromPlaces('bakery in Pune', 'IN'), /PLACES_API_KEY/);
});

test('importLeadsFromPlaces writes one RawLeads row per place with a website, skipping those without one', () => {
  const placesPayload = {
    places: [
      { displayName: { text: 'Acme Bakery' }, websiteUri: 'https://acmebakery.com', formattedAddress: 'Pune', internationalPhoneNumber: '+91', types: ['bakery'] },
      { displayName: { text: 'No Website Co' }, formattedAddress: 'Pune', types: ['bakery'] }
    ]
  };
  const { context } = createEnv({
    properties: { PLACES_API_KEY: 'pk' },
    fetchHandler: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(placesPayload) })
  });
  context.setupSheets();

  context.importLeadsFromPlaces('bakery in Pune', 'IN');

  const rows = context.readSheetAsObjects_('RawLeads');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_name, 'Acme Bakery');
  assert.equal(rows[0].status, 'new');
});

function nominatimResult(overrides) {
  return [Object.assign({ osm_type: 'relation', osm_id: 12345 }, overrides)];
}

function overpassElements(elements) {
  return { elements: elements };
}

test('autoSourceLeads reports no_queries_configured when SourceQueries is empty', () => {
  const { context } = createEnv();
  context.setupSheets();
  const result = context.autoSourceLeads();
  assert.equal(result.found, 0);
  assert.equal(result.reason, 'no_queries_configured');
});

test('autoSourceLeads geocodes once, queries Overpass, and only keeps results with both a name and a website', () => {
  let nominatimCalls = 0;
  let overpassCalls = 0;
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) {
        nominatimCalls++;
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      }
      if (url.indexOf('overpass') !== -1) {
        overpassCalls++;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify(overpassElements([
            { tags: { name: 'Acme Bakery', website: 'https://acmebakery.com' } },
            { tags: { name: 'No Website Co' } },
            { tags: { website: 'https://noname.com' } }
          ]))
        };
      }
      throw new Error('unexpected url: ' + url);
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.found, 1);
  assert.equal(nominatimCalls, 1);
  assert.equal(overpassCalls, 1);
  const rows = context.readSheetAsObjects_('RawLeads');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_name, 'Acme Bakery');
  assert.equal(rows[0].source, 'osm');
  assert.equal(rows[0].status, 'new');

  const queries = context.readSheetAsObjects_('SourceQueries');
  assert.equal(queries[0].total_found, 1);
  assert.ok(queries[0].area_id, 'area_id should be cached after geocoding');
  assert.ok(queries[0].last_run_at, 'last_run_at should be stamped');
});

test('autoSourceLeads reuses the cached area_id on a later run instead of geocoding again', () => {
  let nominatimCalls = 0;
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) {
        nominatimCalls++;
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  context.autoSourceLeads();
  context.autoSourceLeads();

  assert.equal(nominatimCalls, 1, 'second run should reuse the cached area_id');
});

test('autoSourceLeads skips a lead whose domain already exists in RawLeads', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(overpassElements([{ tags: { name: 'Acme Bakery', website: 'https://acmebakery.com' } }]))
      };
    }
  });
  context.setupSheets();
  context.appendRow_('RawLeads', { lead_id: 'existing', company_name: 'Acme Bakery', website: 'acmebakery.com', status: 'new' });
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.found, 0);
  assert.equal(context.readSheetAsObjects_('RawLeads').length, 1);
});

test('autoSourceLeads picks the row that has never run, or ran longest ago, each time', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India', last_run_at: '2020-01-01T00:00:00.000Z' });
  context.appendRow_('SourceQueries', { category: 'Cafe', osm_tag: 'amenity=cafe', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.category, 'Cafe', 'the never-run row should be picked before the stale-but-run one');
});

test('autoSourceLeads skips past point-only Nominatim results to find an area candidate', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify([
            { osm_type: 'node', osm_id: 1 },
            { osm_type: 'node', osm_id: 2 },
            { osm_type: 'relation', osm_id: 99 }
          ])
        };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  context.autoSourceLeads();

  const queries = context.readSheetAsObjects_('SourceQueries');
  assert.equal(queries[0].area_id, 3600000000 + 99, 'should use the first area-shaped (relation/way) result, not the point results ahead of it');
});

test('autoSourceLeads fails clearly when every Nominatim result is a point, not an area', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify([{ osm_type: 'node', osm_id: 1 }]) };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Some Tiny Hamlet' });

  const result = context.autoSourceLeads();

  assert.match(result.error, /only resolved to point results/);
});

test('autoSourceLeads logs the error and still stamps last_run_at when every Overpass mirror fails', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return { getResponseCode: () => 503, getContentText: () => 'Overpass is overloaded' };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.found, 0);
  assert.ok(result.error);
  assert.equal(context.readSheetAsObjects_('Errors').length, 1);
  assert.ok(context.readSheetAsObjects_('SourceQueries')[0].last_run_at, 'a failed run should still move on next time');
});

test('autoSourceLeads falls back to the next Overpass mirror when the first one errors', () => {
  let callsPerMirror = {};
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      callsPerMirror[url] = (callsPerMirror[url] || 0) + 1;
      if (url.indexOf('overpass-api.de') !== -1) return { getResponseCode: () => 406, getContentText: () => 'Not Acceptable' };
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(overpassElements([{ tags: { name: 'Acme Bakery', website: 'https://acmebakery.com' } }]))
      };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.found, 1, 'should succeed via the second mirror after the first one 406s');
  assert.equal(context.readSheetAsObjects_('RawLeads')[0].company_name, 'Acme Bakery');
});

test('autoSourceLeads skips rows disabled from the dashboard', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India', enabled: 'FALSE' });
  context.appendRow_('SourceQueries', { category: 'Cafe', osm_tag: 'amenity=cafe', location: 'Ahmedabad, India', enabled: 'TRUE' });

  const result = context.autoSourceLeads();

  assert.equal(result.category, 'Cafe', 'the disabled Bakery row should be skipped entirely');
});

test('autoSourceLeads treats a blank enabled cell as enabled (existing rows before the column was added)', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(overpassElements([])) };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });

  const result = context.autoSourceLeads();

  assert.equal(result.category, 'Bakery');
});

test('runSourceQueryNow forces a specific row immediately, ignoring last-run order', () => {
  const { context } = createEnv({
    fetchHandler: (url) => {
      if (url.indexOf('nominatim') !== -1) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(nominatimResult()) };
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(overpassElements([{ tags: { name: 'Cafe Co', website: 'https://cafeco.com' } }]))
      };
    }
  });
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });
  context.appendRow_('SourceQueries', { category: 'Cafe', osm_tag: 'amenity=cafe', location: 'Ahmedabad, India', last_run_at: new Date().toISOString() });

  const result = context.runSourceQueryNow(3); // row 1 is the header, row 2 Bakery, row 3 Cafe

  assert.equal(result.category, 'Cafe', 'should run the requested row even though it ran most recently');
});

test('runSourceQueryNow refuses a disabled row', () => {
  const { context } = createEnv();
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India', enabled: 'FALSE' });

  assert.throws(() => context.runSourceQueryNow(2), /disabled/);
});

test('listSourceQueries / addSourceQuery / setSourceQueryEnabled / deleteSourceQueryRow round-trip', () => {
  const { context } = createEnv();
  context.setupSheets();

  context.addSourceQuery('Bakery', 'shop=bakery', 'Ahmedabad, India');
  let rows = context.listSourceQueries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'Bakery');
  assert.equal(rows[0].enabled, 'TRUE');

  context.setSourceQueryEnabled(rows[0]._rowNumber, false);
  rows = context.listSourceQueries();
  assert.equal(rows[0].enabled, 'FALSE');

  context.deleteSourceQueryRow(rows[0]._rowNumber);
  rows = context.listSourceQueries();
  assert.equal(rows.length, 0);
});

test('addSourceQuery rejects a missing field instead of writing a half-empty row', () => {
  const { context } = createEnv();
  context.setupSheets();
  assert.throws(() => context.addSourceQuery('', 'shop=bakery', 'Ahmedabad, India'), /required/);
  assert.equal(context.listSourceQueries().length, 0);
});

test('setAllSourceQueriesEnabled toggles every configured row at once', () => {
  const { context } = createEnv();
  context.setupSheets();
  context.appendRow_('SourceQueries', { category: 'Bakery', osm_tag: 'shop=bakery', location: 'Ahmedabad, India' });
  context.appendRow_('SourceQueries', { category: 'Cafe', osm_tag: 'amenity=cafe', location: 'Ahmedabad, India' });

  context.setAllSourceQueriesEnabled(false);
  let rows = context.listSourceQueries();
  assert.ok(rows.every((r) => r.enabled === 'FALSE'));

  context.setAllSourceQueriesEnabled(true);
  rows = context.listSourceQueries();
  assert.ok(rows.every((r) => r.enabled === 'TRUE'));
});
