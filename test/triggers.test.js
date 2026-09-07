'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

test('installCentralTriggers installs exactly the five central jobs and clears old ones first', () => {
  const { context } = createEnv();
  context.ScriptApp.newTrigger('someStaleTrigger').timeBased().everyMinutes(1).create();

  context.installCentralTriggers();

  const names = context.ScriptApp._triggers().map((t) => t.handlerFunctionName).sort();
  assert.deepEqual(names, ['checkReplies', 'classifyLeads', 'draftEmails', 'findContacts', 'normalizeRawLeads', 'queueApprovedDrafts'].sort());
});

test('installSenderTriggers installs only sendQueue', () => {
  const { context } = createEnv();
  context.installSenderTriggers();
  const triggers = context.ScriptApp._triggers();
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].handlerFunctionName, 'sendQueue');
});

test('deleteAllTriggers empties the trigger list', () => {
  const { context } = createEnv();
  context.installCentralTriggers();
  context.deleteAllTriggers();
  assert.equal(context.ScriptApp._triggers().length, 0);
});

test('installAllTriggersSingleAccount installs all seven jobs and clears old ones first', () => {
  const { context } = createEnv();
  context.ScriptApp.newTrigger('someStaleTrigger').timeBased().everyMinutes(1).create();

  context.installAllTriggersSingleAccount();

  const names = context.ScriptApp._triggers().map((t) => t.handlerFunctionName).sort();
  assert.deepEqual(names, ['checkReplies', 'classifyLeads', 'draftEmails', 'findContacts', 'normalizeRawLeads', 'queueApprovedDrafts', 'sendQueue'].sort());
});
