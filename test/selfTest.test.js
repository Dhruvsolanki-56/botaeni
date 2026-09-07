'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, geminiResponse, promptFromGeminiPayload } = require('./appsScriptEnv');

const FULL_PROPS = {
  GEMINI_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'me@gmail.com', ICP_DESCRIPTION: 'SMBs',
  SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18', DAILY_CAP_PER_SENDER: '10'
};

function geminiSelfTestHandler(url, options) {
  const prompt = promptFromGeminiPayload(options);
  if (prompt.indexOf('single word: OK') !== -1) return geminiResponse('OK');
  return geminiResponse(JSON.stringify({ status: 'ok' }));
}

test('runSelfTest passes end to end against a fully configured, healthy environment', () => {
  const { context, state } = createEnv({ properties: FULL_PROPS, fetchHandler: geminiSelfTestHandler });
  context.setupSheets();

  const results = context.runSelfTest();

  // results/failures are arrays from the vm sandbox's own realm — compare by
  // value (length + a readable dump), not assert.deepEqual, which chokes on
  // cross-realm array identity even when both sides are empty.
  const failures = Array.from(results).filter((r) => !r.ok);
  assert.equal(failures.length, 0, 'expected every self-test check to pass: ' + JSON.stringify(failures));
  assert.ok(state.sentEmails.some((m) => m.subject.indexOf('self-test') !== -1), 'expected the end-to-end test email to be sent');
});

test('runSelfTest fails fast and clearly when required config is missing', () => {
  const { context } = createEnv({ properties: {}, fetchHandler: geminiSelfTestHandler });
  context.setupSheets();

  const results = context.runSelfTest();

  const configCheck = results.find((r) => r.name.indexOf('script properties') !== -1);
  assert.equal(configCheck.ok, false);
  assert.match(configCheck.error, /GEMINI_API_KEY/);
});

test('runSelfTest reports a failure if the sheet structure is missing or wrong', () => {
  const { context } = createEnv({ properties: FULL_PROPS, fetchHandler: geminiSelfTestHandler });
  // deliberately skip setupSheets()

  const results = context.runSelfTest();

  const sheetCheck = results.find((r) => r.name.indexOf('sheet tabs') !== -1);
  assert.equal(sheetCheck.ok, false);
});

test('runSelfTest flags DAILY_CAP_PER_SENDER values above the plan\'s safe range', () => {
  const props = Object.assign({}, FULL_PROPS, { DAILY_CAP_PER_SENDER: '100' });
  const { context } = createEnv({ properties: props, fetchHandler: geminiSelfTestHandler });
  context.setupSheets();

  const results = context.runSelfTest();

  const capCheck = results.find((r) => r.name.indexOf('send-window and sender-cap') !== -1);
  assert.equal(capCheck.ok, false);
});
