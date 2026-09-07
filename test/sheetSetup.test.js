'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

test('setupSheets creates every tab from HEADERS with the correct header row', () => {
  const { context, spreadsheet } = createEnv();
  context.setupSheets();
  Object.keys(context.HEADERS).forEach((name) => {
    const sheet = spreadsheet.getSheetByName(name);
    assert.ok(sheet, `expected sheet "${name}" to exist`);
    const expected = Array.from(context.HEADERS[name]); // HEADERS lives in the vm sandbox's own realm
    const header = sheet.getRange(1, 1, 1, expected.length).getValues()[0];
    assert.deepEqual(header, expected);
  });
  assert.ok(spreadsheet.getSheetByName('ReadMe'), 'expected the ReadMe reference tab to exist');
});

test('setupSheets is idempotent — re-running does not wipe existing rows', () => {
  const { context, spreadsheet } = createEnv();
  context.setupSheets();
  context.appendRow_('Suppression', { email: 'kept@example.com', reason: 'test', added_at: 'now' });
  context.setupSheets();
  const rows = context.readSheetAsObjects_('Suppression');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'kept@example.com');
});
