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
