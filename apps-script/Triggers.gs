/**
 * Run installCentralTriggers() once, under the main account (the one that
 * owns the sheet and holds REPLY_TO_EMAIL). Run installSenderTriggers()
 * once in EACH sending account's separate deployment (see Sender.gs).
 */
function installCentralTriggers() {
  deleteAllTriggers();
  ScriptApp.newTrigger('normalizeRawLeads').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('classifyLeads').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('findContacts').timeBased().everyHours(4).create();
  ScriptApp.newTrigger('draftEmails').timeBased().everyHours(4).create();
  ScriptApp.newTrigger('queueApprovedDrafts').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkReplies').timeBased().everyMinutes(30).create();
  Logger.log('Central triggers installed.');
}

function installSenderTriggers() {
  deleteAllTriggers();
  ScriptApp.newTrigger('sendQueue').timeBased().everyMinutes(30).create();
  Logger.log('Sender trigger installed for ' + Session.getActiveUser().getEmail());
}

function deleteAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}
