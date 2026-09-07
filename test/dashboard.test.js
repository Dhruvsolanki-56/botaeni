'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

const BASE_PROPS = {
  GEMINI_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'a@gmail.com,b@gmail.com',
  ICP_DESCRIPTION: 'SMBs', ICP_FIT_THRESHOLD: '60', DAILY_CAP_PER_SENDER: '10'
};

function seedFullPipeline(context) {
  context.setupSheets();
  context.appendRow_('RawLeads', { lead_id: 'l1', company_name: 'Acme', website: 'acme.com', status: 'classified' });
  context.appendRow_('RawLeads', { lead_id: 'l2', company_name: 'Bravo', website: 'bravo.com', status: 'new' });
  context.appendRow_('Classified', { lead_id: 'l1', icp_fit_score: 80, pitch_angle: 'x' });
  context.appendRow_('Classified', { lead_id: 'l2', icp_fit_score: 30, pitch_angle: '' });
  context.appendRow_('Classified', { lead_id: 'l3', icp_fit_score: 0, pitch_angle: '', confidence: 'low' });
  context.appendRow_('Contacts', { lead_id: 'l1', contact_email: 'owner@acme.com', verification_status: 'valid' });
  context.appendRow_('Drafts', { lead_id: 'l1', contact_email: 'owner@acme.com', status: 'approved' });
  context.appendRow_('SendQueue', { lead_id: 'l1', contact_email: 'owner@acme.com', status: 'sent', assigned_sender: 'a@gmail.com' });
  context.appendRow_('SentLog', { lead_id: 'l1', contact_email: 'owner@acme.com', sender: 'a@gmail.com', subject: 'Hi', sent_at: new Date().toISOString(), status: 'sent' });
  context.appendRow_('Replies', { lead_id: 'l1', contact_email: 'owner@acme.com', message_id: 'm1', received_at: new Date().toISOString(), snippet: 'Sounds good', category: 'interested', urgency: 'high' });
  context.appendRow_('Suppression', { email: 'blocked@example.com', reason: 'unsubscribe', added_at: 'now' });
  context.appendRow_('Errors', { timestamp: new Date().toISOString(), function_name: 'classifyLeads', message: 'boom', context: '' });
}

test('getDashboardData computes an accurate funnel and breakdowns from seeded sheets', () => {
  const { context } = createEnv({ properties: BASE_PROPS });
  seedFullPipeline(context);

  const data = context.getDashboardData();

  const byStage = {};
  Array.from(data.funnel).forEach((f) => { byStage[f.stage] = f.count; });
  assert.equal(byStage.Sourced, 2);
  assert.equal(byStage.Classified, 3);
  assert.equal(byStage['ICP fit'], 1, 'only l1 clears the 60 threshold');
  assert.equal(byStage['Contact found'], 1);
  assert.equal(byStage.Sent, 1);
  assert.equal(byStage.Replied, 1);
  assert.equal(byStage.Interested, 1);
  assert.equal(data.avgIcpScore, 55, 'average of the two scored leads (80, 30) — l3\'s unset/0 score is excluded');
  assert.equal(data.suppressionCount, 1);
  assert.equal(data.totalErrors, 1);
  assert.equal(data.errorCount24h, 1);

  const senders = Array.from(data.senderStats);
  assert.equal(senders.length, 2);
  const senderA = senders.find((s) => s.sender === 'a@gmail.com');
  assert.equal(senderA.totalSent, 1);
  assert.equal(senderA.sentToday, 1);
});

test('getDashboardData handles a completely empty pipeline without dividing by zero', () => {
  const { context } = createEnv({ properties: BASE_PROPS });
  context.setupSheets();

  const data = context.getDashboardData();

  assert.equal(data.avgIcpScore, 0);
  assert.equal(Array.from(data.recentActivity).length, 0);
  assert.equal(Array.from(data.funnel)[0].count, 0);
});

test('getSheetRows returns the header and the most recent rows, newest first', () => {
  const { context } = createEnv({ properties: BASE_PROPS });
  context.setupSheets();
  context.appendRow_('Suppression', { email: 'first@x.com', reason: 'a', added_at: '1' });
  context.appendRow_('Suppression', { email: 'second@x.com', reason: 'b', added_at: '2' });

  const result = context.getSheetRows('Suppression', 200);

  assert.deepEqual(Array.from(result.header), ['email', 'reason', 'added_at']);
  const rows = Array.from(result.rows);
  assert.equal(rows[0].email, 'second@x.com', 'newest row should come first');
  assert.equal(rows[1].email, 'first@x.com');
});

test('getSheetRows rejects an unknown sheet name', () => {
  const { context } = createEnv({ properties: BASE_PROPS });
  context.setupSheets();
  assert.throws(() => context.getSheetRows('NotASheet', 10), /Unknown sheet/);
});

test('doGet serves the dashboard only when the access key matches', () => {
  const { context } = createEnv({ properties: Object.assign({}, BASE_PROPS, { DASHBOARD_ACCESS_KEY: 'secret123' }) });
  context.setupSheets();

  const noKey = context.doGet({ parameter: {} });
  assert.equal(noKey.getContent(), '<p>Not found.</p>');

  const wrongKey = context.doGet({ parameter: { key: 'wrong' } });
  assert.equal(wrongKey.getContent(), '<p>Not found.</p>');

  const rightKey = context.doGet({ parameter: { key: 'secret123' } });
  assert.match(rightKey.getContent(), /Lead-Gen Autopilot/);
  assert.equal(rightKey.getTitle(), 'Lead-Gen Autopilot Dashboard');
});

test('doGet refuses the dashboard entirely when no access key is configured', () => {
  const { context } = createEnv({ properties: BASE_PROPS }); // no DASHBOARD_ACCESS_KEY
  context.setupSheets();

  const result = context.doGet({ parameter: { key: '' } });
  assert.equal(result.getContent(), '<p>Not found.</p>');
});

test('doGet still routes email+token requests to the unsubscribe handler, key or not', () => {
  const { context } = createEnv({ properties: Object.assign({}, BASE_PROPS, { UNSUB_SECRET: 's3cr3t' }) });
  context.setupSheets();

  const result = context.doGet({ parameter: { email: 'x@example.com', token: 'not-the-real-token' } });
  assert.match(result.getContent(), /Invalid or expired/);
});

test('doPost unsubscribes with a valid signed token', () => {
  const { context } = createEnv({ properties: Object.assign({}, BASE_PROPS, { UNSUB_SECRET: 's3cr3t' }) });
  context.setupSheets();
  const token = context.signUnsubscribeToken_('x@example.com', 's3cr3t');

  const result = context.doPost({ parameter: { email: 'x@example.com', token: token } });

  assert.match(result.getContent(), /unsubscribed/);
  assert.equal(context.isSuppressed_('x@example.com'), true);
});
