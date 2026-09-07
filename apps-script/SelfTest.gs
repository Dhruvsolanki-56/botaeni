/**
 * Run this once after setup, and any time after changing Script Properties,
 * before turning on triggers. It never emails a real prospect — the one
 * message it sends goes to NOTIFY_EMAIL only, clearly marked as a test.
 * Read the Logger output (View > Logs) for a pass/fail summary.
 */
function runSelfTest() {
  const results = [];
  const record = function (name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: e.message });
    }
  };

  record('required script properties are set', function () {
    validateConfig_();
  });

  record('all sheet tabs exist with the expected headers', function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    Object.keys(HEADERS).forEach(function (name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) throw new Error('Sheet "' + name + '" is missing — run setupSheets().');
      const actual = sheet.getRange(1, 1, 1, HEADERS[name].length).getValues()[0];
      const expected = HEADERS[name];
      const matches = expected.every(function (col, i) { return actual[i] === col; });
      if (!matches) throw new Error('Sheet "' + name + '" headers don\'t match. Re-run setupSheets().');
    });
  });

  record('Gemini API key works', function () {
    const reply = callGemini_('Reply with exactly the single word: OK').trim();
    if (reply.toUpperCase().indexOf('OK') === -1) {
      throw new Error('Unexpected Gemini response: ' + reply.substring(0, 100));
    }
  });

  record('Gemini JSON mode parses correctly', function () {
    const parsed = callGeminiJson_('Return a JSON object with exactly one field, "status", set to "ok".');
    if (parsed.status !== 'ok') throw new Error('Unexpected JSON: ' + JSON.stringify(parsed));
  });

  record('sending account has send quota remaining', function () {
    const remaining = MailApp.getRemainingDailyQuota();
    if (remaining <= 0) throw new Error('This account has 0 remaining email quota today.');
    Logger.log('Remaining Gmail quota today for ' + Session.getActiveUser().getEmail() + ': ' + remaining);
  });

  record('Hunter API key works (skipped if not set)', function () {
    const config = getConfig();
    if (!config.hunterApiKey) { Logger.log('HUNTER_API_KEY not set — contact discovery will require manual entry. This is fine on the $0 stack.'); return; }
    const response = fetchWithRetry_('https://api.hunter.io/v2/account?api_key=' + config.hunterApiKey, { muteHttpExceptions: true }, 1);
    if (response.getResponseCode() !== 200) throw new Error('Hunter API key rejected: ' + response.getContentText().substring(0, 200));
  });

  record('Gmail advanced service / List-Unsubscribe path', function () {
    if (isGmailAdvancedServiceAvailable_()) {
      Logger.log('Gmail advanced service is enabled — outgoing mail will carry a real List-Unsubscribe header.');
    } else {
      Logger.log('Gmail advanced service not enabled — falling back to plain GmailApp.sendEmail with an in-body unsubscribe line. Fine for the $0 stack; see MimeMail.gs to upgrade.');
    }
  });

  record('send-window and sender-cap logic behave sanely', function () {
    const config = getConfig();
    if (config.sendWindowStartHour >= config.sendWindowEndHour) {
      throw new Error('SEND_WINDOW_START_HOUR must be before SEND_WINDOW_END_HOUR.');
    }
    if (config.dailyCapPerSender > 30) {
      throw new Error('DAILY_CAP_PER_SENDER (' + config.dailyCapPerSender + ') is above the safe range the plan recommends — see §07.');
    }
  });

  record('a live test email sends end-to-end', function () {
    const config = getConfig();
    sendProductionEmail_(
      config.notifyEmail,
      'Lead-Gen Autopilot self-test — ' + nowIso_(),
      'This is an automated self-test message. If you got this, sending works end-to-end.',
      config
    );
  });

  const failed = results.filter(function (r) { return !r.ok; });
  Logger.log('=== SELF-TEST RESULTS: ' + (results.length - failed.length) + '/' + results.length + ' passed ===');
  results.forEach(function (r) {
    Logger.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  — ' + r.error));
  });
  if (failed.length > 0) {
    Logger.log('Fix the FAIL lines above before installing triggers.');
  }
  return results;
}
