'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./appsScriptEnv');

test('installCentralTriggers installs exactly the six central jobs and clears old ones first', () => {
  const { context } = createEnv();
  context.ScriptApp.newTrigger('someStaleTrigger').timeBased().everyMinutes(1).create();

  context.installCentralTriggers();

  const names = context.ScriptApp._triggers().map((t) => t.handlerFunctionName).sort();
  assert.deepEqual(names, ['autoSourceLeads', 'checkReplies', 'classifyLeads', 'draftEmails', 'findContacts', 'normalizeRawLeads', 'queueApprovedDrafts'].sort());
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

test('installAllTriggersSingleAccount installs all eight jobs and clears old ones first', () => {
  const { context } = createEnv();
  context.ScriptApp.newTrigger('someStaleTrigger').timeBased().everyMinutes(1).create();

  context.installAllTriggersSingleAccount();

  const names = context.ScriptApp._triggers().map((t) => t.handlerFunctionName).sort();
  assert.deepEqual(names, ['autoSourceLeads', 'checkReplies', 'classifyLeads', 'draftEmails', 'findContacts', 'normalizeRawLeads', 'queueApprovedDrafts', 'sendQueue'].sort());
});

test('getAutomationStatus reports stopped when no triggers exist', () => {
  const { context } = createEnv();
  const status = context.getAutomationStatus();
  assert.equal(status.running, false);
  assert.equal(status.triggerCount, 0);
});

test('getAutomationStatus reports running with the installed trigger names once triggers exist', () => {
  const { context } = createEnv();
  context.installAllTriggersSingleAccount();

  const status = context.getAutomationStatus();

  assert.equal(status.running, true);
  assert.equal(status.triggerCount, 8);
  assert.deepEqual(Array.from(status.triggerNames), ['autoSourceLeads', 'checkReplies', 'classifyLeads', 'draftEmails', 'findContacts', 'normalizeRawLeads', 'queueApprovedDrafts', 'sendQueue'].sort());
});

test('the dashboard\'s startAutomation installs every trigger and returns the resulting status', () => {
  const { context } = createEnv();
  const status = context.startAutomation();
  assert.equal(status.running, true);
  assert.equal(status.triggerCount, 8);
});

test('the dashboard\'s stopAutomation removes every trigger and returns the resulting status', () => {
  const { context } = createEnv();
  context.installAllTriggersSingleAccount();
  const status = context.stopAutomation();
  assert.equal(status.running, false);
  assert.equal(status.triggerCount, 0);
});
