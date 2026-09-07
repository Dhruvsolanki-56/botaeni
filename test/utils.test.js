'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

test('normalizeDomain_ strips protocol, www, and path', () => {
  const { context } = createEnv();
  assert.equal(context.normalizeDomain_('https://www.Example.com/about'), 'example.com');
  assert.equal(context.normalizeDomain_('example.com'), 'example.com');
  assert.equal(context.normalizeDomain_(''), '');
});

test('generateLeadId_ is deterministic and distinguishes companies', () => {
  const { context } = createEnv();
  const a1 = context.generateLeadId_('Acme Bakery', 'https://acmebakery.com');
  const a2 = context.generateLeadId_('Acme Bakery', 'https://acmebakery.com/');
  const b = context.generateLeadId_('Other Co', 'https://othersite.com');
  assert.equal(a1, a2, 'same normalized domain must produce the same id');
  assert.notEqual(a1, b);
});

test('suppression list: isSuppressed_ / addSuppression_ round-trip, case-insensitive', () => {
  const { context } = createEnv();
  context.setupSheets();
  assert.equal(context.isSuppressed_('person@example.com'), false);
  context.addSuppression_('Person@Example.com', 'unsubscribe');
  assert.equal(context.isSuppressed_('person@example.com'), true);
});

test('isSuppressed_ treats an empty/missing email as suppressed (fail closed)', () => {
  const { context } = createEnv();
  context.setupSheets();
  assert.equal(context.isSuppressed_(''), true);
  assert.equal(context.isSuppressed_(undefined), true);
});

test('stripHtml_ removes scripts, styles and tags', () => {
  const { context } = createEnv();
  const html = '<html><head><style>.x{color:red}</style></head><body><script>evil()</script><p>Hello&nbsp;World</p></body></html>';
  assert.equal(context.stripHtml_(html), 'Hello World');
});

test('isWithinSendWindow_ respects the configured hour window', () => {
  const { context } = createEnv({
    properties: { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18' },
    now: new Date('2026-09-08T10:00:00Z') // a Tuesday
  });
  assert.equal(context.isWithinSendWindow_(), true);
});

test('isWithinSendWindow_ is false before the start hour and at/after the end hour', () => {
  const before = createEnv({ properties: { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18' }, now: new Date('2026-09-08T05:00:00Z') });
  const after = createEnv({ properties: { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18' }, now: new Date('2026-09-08T18:00:00Z') });
  assert.equal(before.context.isWithinSendWindow_(), false);
  assert.equal(after.context.isWithinSendWindow_(), false);
});

test('isWithinSendWindow_ blocks weekends unless SEND_ON_WEEKENDS is true', () => {
  const saturday = new Date('2026-09-12T10:00:00Z'); // Saturday
  const blocked = createEnv({ properties: { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18' }, now: saturday });
  const allowed = createEnv({ properties: { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18', SEND_ON_WEEKENDS: 'true' }, now: saturday });
  assert.equal(blocked.context.isWithinSendWindow_(), false);
  assert.equal(allowed.context.isWithinSendWindow_(), true);
});

test('fetchWithRetry_ retries on 500 then succeeds', () => {
  const { context } = createEnv({
    fetchHandler: (() => {
      let calls = 0;
      return () => {
        calls++;
        if (calls < 2) return { getResponseCode: () => 500, getContentText: () => 'boom' };
        return { getResponseCode: () => 200, getContentText: () => 'ok' };
      };
    })()
  });
  const response = context.fetchWithRetry_('https://example.com', {}, 3);
  assert.equal(response.getContentText(), 'ok');
});

test('fetchWithRetry_ gives up after exhausting retries', () => {
  const { context } = createEnv({ fetchHandler: () => ({ getResponseCode: () => 500, getContentText: () => 'still broken' }) });
  assert.throws(() => context.fetchWithRetry_('https://example.com', {}, 1));
});

test('validateConfig_ lists every missing required key', () => {
  const { context } = createEnv({ properties: {} });
  assert.throws(() => context.validateConfig_(), /GEMINI_API_KEY/);
});

test('validateConfig_ passes once all required keys are set', () => {
  const { context } = createEnv({
    properties: {
      GEMINI_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
      REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'a@gmail.com', ICP_DESCRIPTION: 'SMBs'
    }
  });
  assert.doesNotThrow(() => context.validateConfig_());
});
