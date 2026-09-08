'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, geminiResponse } = require('./appsScriptEnv');

const REQUIRED_PROPS = {
  GROQ_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'a@gmail.com,b@gmail.com', ICP_DESCRIPTION: 'SMBs'
};

function seedContactedLead(context, id, opts) {
  opts = opts || {};
  context.appendRow_('Classified', Object.assign({
    lead_id: id, industry: 'Food', pitch_angle: 'Paid ads would fit them well.',
    evidence_snippet: 'We help local bakeries increase foot traffic.', confidence: 'high', icp_fit_score: 80
  }, opts.classified));
  context.appendRow_('Contacts', Object.assign({
    lead_id: id, contact_name: 'Priya Rao', contact_title: 'Owner', contact_email: id + '@example.com',
    verification_status: 'valid', source: 'hunter.io', found_at: 'now'
  }, opts.contact));
}

test('draftEmails writes a pending_review draft grounded in the evidence snippet', () => {
  const { context } = createEnv({
    properties: REQUIRED_PROPS,
    fetchHandler: () => geminiResponse('We noticed you help local bakeries drive more foot traffic.')
  });
  context.setupSheets();
  seedContactedLead(context, 'lead1');

  context.draftEmails();

  const drafts = context.readSheetAsObjects_('Drafts');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].status, 'pending_review');
  assert.match(drafts[0].body, /foot traffic/);
  assert.match(drafts[0].body, /AdSolutions/);
});

test('draftEmails writes nothing when the model reports INSUFFICIENT_SIGNAL', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS, fetchHandler: () => geminiResponse('INSUFFICIENT_SIGNAL') });
  context.setupSheets();
  seedContactedLead(context, 'lead1');

  context.draftEmails();

  assert.equal(context.readSheetAsObjects_('Drafts').length, 0);
});

test('draftEmails skips a lead with no pitch_angle rather than guessing', () => {
  let called = false;
  const { context } = createEnv({ properties: REQUIRED_PROPS, fetchHandler: () => { called = true; return geminiResponse('anything'); } });
  context.setupSheets();
  seedContactedLead(context, 'lead1', { classified: { pitch_angle: '' } });

  context.draftEmails();

  assert.equal(called, false);
  assert.equal(context.readSheetAsObjects_('Drafts').length, 0);
});

test('draftEmails never drafts to a suppressed contact', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS, fetchHandler: () => geminiResponse('opener') });
  context.setupSheets();
  seedContactedLead(context, 'lead1');
  context.addSuppression_('lead1@example.com', 'unsubscribe');

  context.draftEmails();

  assert.equal(context.readSheetAsObjects_('Drafts').length, 0);
});

test('queueApprovedDrafts round-robins across SENDER_ACCOUNTS and persists the counter across runs', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'a@x.com', subject: 's1', body: 'b1', status: 'approved' });
  context.queueApprovedDrafts();

  context.appendRow_('Drafts', { lead_id: 'lead2', contact_email: 'b@x.com', subject: 's2', body: 'b2', status: 'approved' });
  context.queueApprovedDrafts();

  const queue = context.readSheetAsObjects_('SendQueue');
  assert.equal(queue.length, 2);
  assert.equal(queue[0].assigned_sender, 'a@gmail.com');
  assert.equal(queue[1].assigned_sender, 'b@gmail.com');
});

test('queueApprovedDrafts ignores drafts not marked approved, and suppressed contacts', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'pending@x.com', subject: 's', body: 'b', status: 'pending_review' });
  context.appendRow_('Drafts', { lead_id: 'lead2', contact_email: 'blocked@x.com', subject: 's', body: 'b', status: 'approved' });
  context.addSuppression_('blocked@x.com', 'unsubscribe');

  context.queueApprovedDrafts();

  assert.equal(context.readSheetAsObjects_('SendQueue').length, 0);
});

test('queueApprovedDrafts throws a clear error when SENDER_ACCOUNTS is empty', () => {
  const props = Object.assign({}, REQUIRED_PROPS, { SENDER_ACCOUNTS: '' });
  const { context } = createEnv({ properties: props });
  context.setupSheets();
  assert.throws(() => context.queueApprovedDrafts(), /SENDER_ACCOUNTS/);
});

test('listPendingDrafts returns only pending_review drafts, for the dashboard review panel', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'a@x.com', subject: 's1', body: 'b1', status: 'pending_review' });
  context.appendRow_('Drafts', { lead_id: 'lead2', contact_email: 'b@x.com', subject: 's2', body: 'b2', status: 'approved' });
  context.appendRow_('Drafts', { lead_id: 'lead3', contact_email: 'c@x.com', subject: 's3', body: 'b3', status: 'rejected' });

  const pending = context.listPendingDrafts();

  assert.equal(pending.length, 1);
  assert.equal(pending[0].lead_id, 'lead1');
  assert.ok(pending[0]._rowNumber, 'row number must be exposed so the dashboard can act on the right row');
});

test('setDraftStatus approves a draft and stamps reviewed_at', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'a@x.com', subject: 's1', body: 'b1', status: 'pending_review' });
  const rowNumber = context.readSheetAsObjects_('Drafts')[0]._rowNumber;

  const remaining = context.setDraftStatus(rowNumber, 'approved');

  const drafts = context.readSheetAsObjects_('Drafts');
  assert.equal(drafts[0].status, 'approved');
  assert.ok(drafts[0].reviewed_at);
  assert.equal(remaining.length, 0, 'the approved draft should drop out of the pending list it returns');
});

test('setDraftStatus rejects a draft', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'a@x.com', subject: 's1', body: 'b1', status: 'pending_review' });
  const rowNumber = context.readSheetAsObjects_('Drafts')[0]._rowNumber;

  context.setDraftStatus(rowNumber, 'rejected');

  assert.equal(context.readSheetAsObjects_('Drafts')[0].status, 'rejected');
});

test('setDraftStatus refuses any status other than approved/rejected', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  context.setupSheets();
  context.appendRow_('Drafts', { lead_id: 'lead1', contact_email: 'a@x.com', subject: 's1', body: 'b1', status: 'pending_review' });

  assert.throws(() => context.setDraftStatus(2, 'sent'), /approved.*rejected/);
});
