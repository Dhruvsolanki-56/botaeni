'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, geminiResponse, makeMessage, makeThread } = require('./appsScriptEnv');

const BASE_PROPS = {
  GEMINI_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'me@gmail.com', ICP_DESCRIPTION: 'SMBs'
};

function seedSentLog(context, contactEmail) {
  context.setupSheets();
  context.appendRow_('SentLog', {
    lead_id: 'lead1', contact_email: contactEmail, sender: 'me@gmail.com', subject: 's',
    sequence_step: 1, sent_at: 'now', status: 'sent'
  });
}

test('checkReplies classifies an unsubscribe reply and suppresses the contact', () => {
  const email = 'prospect@example.com';
  const thread = makeThread([makeMessage({ id: 'm1', plainBody: 'Please remove me from your list.' })]);
  const { context } = createEnv({
    properties: BASE_PROPS,
    searchResults: { ['from:(' + email + ') newer_than:45d']: [thread] },
    fetchHandler: () => geminiResponse(JSON.stringify({ category: 'unsubscribe', urgency: 'low', suggested_action: 'suppress', key_question_or_objection: '' }))
  });
  seedSentLog(context, email);

  context.checkReplies();

  const replies = context.readSheetAsObjects_('Replies');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].category, 'unsubscribe');
  assert.equal(context.isSuppressed_(email), true);
});

test('checkReplies notifies on an interested reply without suppressing the contact', () => {
  const email = 'prospect@example.com';
  const thread = makeThread([makeMessage({ id: 'm1', plainBody: 'Sounds great, let\'s talk.' })]);
  const { context, state } = createEnv({
    properties: BASE_PROPS,
    searchResults: { ['from:(' + email + ') newer_than:45d']: [thread] },
    fetchHandler: () => geminiResponse(JSON.stringify({ category: 'interested', urgency: 'high', suggested_action: 'send calendar link', key_question_or_objection: '' }))
  });
  seedSentLog(context, email);

  context.checkReplies();

  assert.equal(context.isSuppressed_(email), false);
  const notification = state.sentEmails.find((m) => m.subject.indexOf('Interested reply') === 0);
  assert.ok(notification, 'expected a notification email to be sent');
  assert.equal(notification.to, 'adsolutions200@gmail.com');
});

test('checkReplies never reprocesses the same message twice', () => {
  const email = 'prospect@example.com';
  const thread = makeThread([makeMessage({ id: 'm1', plainBody: 'Not interested, thanks.' })]);
  let geminiCalls = 0;
  const { context } = createEnv({
    properties: BASE_PROPS,
    searchResults: { ['from:(' + email + ') newer_than:45d']: [thread] },
    fetchHandler: () => { geminiCalls++; return geminiResponse(JSON.stringify({ category: 'not_interested', urgency: 'low', suggested_action: '', key_question_or_objection: '' })); }
  });
  seedSentLog(context, email);

  context.checkReplies();
  context.checkReplies();

  assert.equal(geminiCalls, 1);
  assert.equal(context.readSheetAsObjects_('Replies').length, 1);
});

test('checkReplies skips drafts and does nothing when SentLog is empty', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS });
  context.setupSheets();

  context.checkReplies();

  assert.equal(context.readSheetAsObjects_('Replies').length, 0);
  assert.equal(state.sentEmails.length, 0);
});

test('checkReplies is a no-op when it cannot acquire the lock', () => {
  const email = 'prospect@example.com';
  const thread = makeThread([makeMessage({ id: 'm1', plainBody: 'hi' })]);
  const { context } = createEnv({
    properties: BASE_PROPS, lock: { alwaysFail: true },
    searchResults: { ['from:(' + email + ') newer_than:45d']: [thread] },
    fetchHandler: () => geminiResponse(JSON.stringify({ category: 'not_now' }))
  });
  seedSentLog(context, email);

  const result = context.checkReplies();

  assert.equal(result, undefined);
  assert.equal(context.readSheetAsObjects_('Replies').length, 0);
});
