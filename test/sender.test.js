'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

const BASE_PROPS = {
  GEMINI_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'me@gmail.com', ICP_DESCRIPTION: 'SMBs',
  SEND_WINDOW_START_HOUR: '0', SEND_WINDOW_END_HOUR: '23', SEND_ON_WEEKENDS: 'true'
};
const WEEKDAY_NOON_UTC = new Date('2026-09-08T12:00:00Z'); // Tuesday

function seedQueue(context, rows) {
  context.setupSheets();
  rows.forEach((r) => context.appendRow_('SendQueue', Object.assign({
    lead_id: 'lead', contact_email: 'x@example.com', subject: 'Quick one', body: 'Hi there', sequence_step: 1,
    status: 'queued', queued_at: 'now'
  }, r)));
}

test('sendQueue sends queued rows assigned to the running account and logs them', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);

  context.sendQueue();

  assert.equal(state.sentEmails.length, 1);
  assert.equal(state.sentEmails[0].to, 'a@example.com');
  const queue = context.readSheetAsObjects_('SendQueue');
  assert.equal(queue[0].status, 'sent');
  const log = context.readSheetAsObjects_('SentLog');
  assert.equal(log.length, 1);
  assert.equal(log[0].sender, 'me@gmail.com');
});

test('sendQueue enforces DAILY_CAP_PER_SENDER even when more rows are queued', () => {
  const { context, state } = createEnv({
    properties: Object.assign({}, BASE_PROPS, { DAILY_CAP_PER_SENDER: '2' }),
    activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC
  });
  seedQueue(context, [
    { lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' },
    { lead_id: 'l2', contact_email: 'b@example.com', assigned_sender: 'me@gmail.com' },
    { lead_id: 'l3', contact_email: 'c@example.com', assigned_sender: 'me@gmail.com' }
  ]);

  context.sendQueue();

  assert.equal(state.sentEmails.length, 2);
  const queue = context.readSheetAsObjects_('SendQueue');
  assert.equal(queue.filter((r) => r.status === 'sent').length, 2);
  assert.equal(queue.filter((r) => r.status === 'queued').length, 1);
});

test('sendQueue only sends rows assigned to the account currently running', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'someone-else@gmail.com' }]);

  context.sendQueue();

  assert.equal(state.sentEmails.length, 0);
  assert.equal(context.readSheetAsObjects_('SendQueue')[0].status, 'queued');
});

test('sendQueue skips (and marks) a suppressed contact instead of sending', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'blocked@example.com', assigned_sender: 'me@gmail.com' }]);
  context.addSuppression_('blocked@example.com', 'unsubscribe');

  context.sendQueue();

  assert.equal(state.sentEmails.length, 0);
  assert.equal(context.readSheetAsObjects_('SendQueue')[0].status, 'skipped_suppressed');
});

test('sendQueue does nothing outside the configured send window', () => {
  const outsideWindow = new Date('2026-09-08T02:00:00Z'); // 2am UTC, window is configured 9-18 here
  const { context, state } = createEnv({
    properties: Object.assign({}, BASE_PROPS, { SEND_WINDOW_START_HOUR: '9', SEND_WINDOW_END_HOUR: '18' }),
    activeUserEmail: 'me@gmail.com', now: outsideWindow
  });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);

  context.sendQueue();

  assert.equal(state.sentEmails.length, 0);
  assert.equal(context.readSheetAsObjects_('SendQueue')[0].status, 'queued');
});

test('sendQueue is a no-op when it cannot acquire the lock (overlapping run protection)', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC, lock: { alwaysFail: true } });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);

  const result = context.sendQueue();

  assert.equal(result, undefined);
  assert.equal(state.sentEmails.length, 0);
  assert.equal(context.readSheetAsObjects_('SendQueue')[0].status, 'queued');
});

test('sendQueue adds a real List-Unsubscribe header via the Gmail API when the advanced service is enabled', () => {
  const { context, state } = createEnv({
    properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC, gmailAdvancedEnabled: true
  });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);

  context.sendQueue();

  assert.equal(state.apiSent.length, 1);
  assert.equal(state.sentEmails.length, 0, 'should use the Gmail API path, not the GmailApp fallback');
  const raw = Buffer.from(state.apiSent[0].resource.raw, 'base64url').toString('utf8');
  assert.match(raw, /List-Unsubscribe: <mailto:adsolutions200@gmail\.com/);
});

test('sendQueue falls back to plain GmailApp.sendEmail when the Gmail advanced service is not enabled', () => {
  const { context, state } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);

  context.sendQueue();

  assert.equal(state.apiSent.length, 0);
  assert.equal(state.sentEmails.length, 1);
  assert.match(state.sentEmails[0].body, /reply "unsubscribe"/);
});

test('sendQueue still delivers the email (via GmailApp fallback) when the Gmail API path throws', () => {
  const { context } = createEnv({ properties: BASE_PROPS, activeUserEmail: 'me@gmail.com', now: WEEKDAY_NOON_UTC, gmailAdvancedEnabled: true });
  seedQueue(context, [{ lead_id: 'l1', contact_email: 'a@example.com', assigned_sender: 'me@gmail.com' }]);
  // Sabotage the Gmail API mock after env creation to force a throw, and disable the advanced-service check
  // by making Users.Messages.send throw, then confirm GmailApp fallback still delivers it rather than failing outright.
  context.Gmail.Users.Messages.send = () => { throw new Error('quota exceeded'); };

  context.sendQueue();

  const queue = context.readSheetAsObjects_('SendQueue');
  assert.equal(queue[0].status, 'sent', 'MimeMail should fall back to GmailApp.sendEmail on API failure');
});
