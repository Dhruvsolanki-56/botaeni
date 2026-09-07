'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

const REQUIRED_PROPS = {
  GROQ_API_KEY: 'k', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'a@gmail.com', ICP_DESCRIPTION: 'SMBs'
};

function seedClassifiedLead(context, props) {
  context.setupSheets();
  context.appendRow_('RawLeads', Object.assign({
    lead_id: 'lead1', source: 'manual', company_name: 'Acme Bakery', website: 'acmebakery.com',
    category: 'bakery', address: '', phone: '', added_at: 'now', status: 'classified'
  }, props && props.raw));
  context.appendRow_('Classified', Object.assign({
    lead_id: 'lead1', industry: 'Food', sub_vertical: 'Bakery', company_size_estimate: 'small',
    icp_fit_score: 75, likely_decision_maker_title: 'Owner', pitch_angle: 'x', evidence_snippet: 'y',
    confidence: 'high', classified_at: 'now'
  }, props && props.classified));
}

test('findContacts marks manual_needed when HUNTER_API_KEY is not set', () => {
  const { context } = createEnv({ properties: REQUIRED_PROPS });
  seedClassifiedLead(context);

  context.findContacts();

  const contacts = context.readSheetAsObjects_('Contacts');
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].verification_status, 'manual_needed');
  assert.equal(contacts[0].contact_email, '');
});

test('findContacts skips leads below the ICP fit threshold', () => {
  const { context } = createEnv({ properties: Object.assign({}, REQUIRED_PROPS, { ICP_FIT_THRESHOLD: '60' }) });
  seedClassifiedLead(context, { classified: { icp_fit_score: 40 } });

  context.findContacts();

  assert.equal(context.readSheetAsObjects_('Contacts').length, 0);
});

test('findContacts picks the Hunter email whose title best matches likely_decision_maker_title', () => {
  const hunterPayload = {
    data: {
      emails: [
        { first_name: 'Sam', last_name: 'Lee', position: 'Marketing Intern', value: 'sam@acmebakery.com', seniority: 'junior', verification: { status: 'valid' } },
        { first_name: 'Priya', last_name: 'Rao', position: 'Owner', value: 'priya@acmebakery.com', seniority: 'executive', verification: { status: 'valid' } }
      ]
    }
  };
  let capturedUrl = '';
  const { context } = createEnv({
    properties: Object.assign({}, REQUIRED_PROPS, { HUNTER_API_KEY: 'hk' }),
    fetchHandler: (url) => {
      capturedUrl = url;
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(hunterPayload) };
    }
  });
  seedClassifiedLead(context);

  context.findContacts();

  assert.match(capturedUrl, /hunter\.io/);
  const contacts = context.readSheetAsObjects_('Contacts');
  assert.equal(contacts[0].contact_email, 'priya@acmebakery.com');
  assert.equal(contacts[0].verification_status, 'valid');
});

test('findContacts logs a failure and marks the row instead of throwing when Hunter errors', () => {
  const { context } = createEnv({
    properties: Object.assign({}, REQUIRED_PROPS, { HUNTER_API_KEY: 'hk' }),
    fetchHandler: () => ({ getResponseCode: () => 500, getContentText: () => 'server error' })
  });
  seedClassifiedLead(context);

  assert.doesNotThrow(() => context.findContacts());

  const contacts = context.readSheetAsObjects_('Contacts');
  assert.match(contacts[0].verification_status, /lookup_failed/);
  assert.equal(context.readSheetAsObjects_('Errors').length, 1);
});

test('findContacts does not re-look-up a lead that already has a Contacts row', () => {
  let calls = 0;
  const { context } = createEnv({
    properties: Object.assign({}, REQUIRED_PROPS, { HUNTER_API_KEY: 'hk' }),
    fetchHandler: () => { calls++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ data: { emails: [] } }) }; }
  });
  seedClassifiedLead(context);
  context.appendRow_('Contacts', { lead_id: 'lead1', contact_email: 'existing@acmebakery.com', verification_status: 'valid' });

  context.findContacts();

  assert.equal(calls, 0);
  assert.equal(context.readSheetAsObjects_('Contacts').length, 1);
});
