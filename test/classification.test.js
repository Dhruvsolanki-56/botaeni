'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, geminiResponse, promptFromGeminiPayload } = require('./appsScriptEnv');

const REQUIRED_PROPS = {
  GEMINI_API_KEY: 'test-key', BUSINESS_NAME: 'AdSolutions', PHYSICAL_ADDRESS: '123 Main St',
  REPLY_TO_EMAIL: 'adsolutions200@gmail.com', SENDER_ACCOUNTS: 'a@gmail.com',
  ICP_DESCRIPTION: 'Small local businesses.'
};

function seedRawLead(context, overrides) {
  context.setupSheets();
  context.appendRow_('RawLeads', Object.assign({
    lead_id: '', source: 'manual', company_name: 'Acme Bakery', website: 'acmebakery.com',
    category: 'bakery', address: 'Pune, India', phone: '', added_at: '', status: ''
  }, overrides));
  context.normalizeRawLeads();
}

test('classifyLeads writes a Classified row and flips RawLeads status', () => {
  let geminiCalls = 0;
  const classification = {
    industry: 'Food & Beverage', sub_vertical: 'Bakery', company_size_estimate: 'small (2-10)',
    icp_fit_score: 78, likely_decision_maker_title: 'Owner',
    pitch_angle: 'They could use paid social ads to drive foot traffic.',
    evidence_snippet: 'We help local bakeries increase foot traffic.', confidence: 'high'
  };
  const { context } = createEnv({
    properties: REQUIRED_PROPS,
    fetchHandler: (url, options) => {
      if (url.indexOf('generativelanguage') !== -1) { geminiCalls++; return geminiResponse(JSON.stringify(classification)); }
      return { getResponseCode: () => 200, getContentText: () => '<p>We help local bakeries increase foot traffic.</p>' };
    }
  });
  seedRawLead(context);

  context.classifyLeads();

  const classified = context.readSheetAsObjects_('Classified');
  assert.equal(classified.length, 1);
  assert.equal(classified[0].industry, 'Food & Beverage');
  assert.equal(classified[0].icp_fit_score, 78);

  const raw = context.readSheetAsObjects_('RawLeads');
  assert.equal(raw[0].status, 'classified');
  assert.equal(geminiCalls, 1);
});

test('classifyLeads never invents facts: the prompt requires the input to carry the evidence', () => {
  let capturedPrompt = '';
  const { context } = createEnv({
    properties: REQUIRED_PROPS,
    fetchHandler: (url, options) => {
      if (url.indexOf('generativelanguage') !== -1) {
        capturedPrompt = promptFromGeminiPayload(options);
        return geminiResponse(JSON.stringify({ industry: 'x', icp_fit_score: 10, confidence: 'low' }));
      }
      return { getResponseCode: () => 200, getContentText: () => '<p>site</p>' };
    }
  });
  seedRawLead(context);
  context.classifyLeads();

  assert.match(capturedPrompt, /never invent facts/i);
  assert.match(capturedPrompt, /Acme Bakery/);
});

test('classifyLeads handles malformed Gemini JSON without crashing, and logs it', () => {
  const { context } = createEnv({
    properties: REQUIRED_PROPS,
    fetchHandler: (url) => {
      if (url.indexOf('generativelanguage') !== -1) return geminiResponse('not valid json {{{');
      return { getResponseCode: () => 200, getContentText: () => '<p>site</p>' };
    }
  });
  seedRawLead(context);

  assert.doesNotThrow(() => context.classifyLeads());

  const raw = context.readSheetAsObjects_('RawLeads');
  assert.match(raw[0].status, /classify_failed/);
  const errors = context.readSheetAsObjects_('Errors');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].function_name, 'classifyLeads');
});

test('classifyLeads skips a lead that already has a Classified row instead of calling Gemini again', () => {
  let geminiCalls = 0;
  const { context } = createEnv({
    properties: REQUIRED_PROPS,
    fetchHandler: (url) => { if (url.indexOf('generativelanguage') !== -1) geminiCalls++; return geminiResponse('{}'); }
  });
  seedRawLead(context);
  const leadId = context.readSheetAsObjects_('RawLeads')[0].lead_id;
  context.appendRow_('Classified', { lead_id: leadId, industry: 'already done', icp_fit_score: 50 });

  context.classifyLeads();

  assert.equal(geminiCalls, 0, 'should not re-classify an already-classified lead');
  assert.equal(context.readSheetAsObjects_('RawLeads')[0].status, 'classified');
  assert.equal(context.readSheetAsObjects_('Classified').length, 1);
});
