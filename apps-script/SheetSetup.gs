/**
 * Run this once from the Apps Script editor (select setupSheets, click Run)
 * against a blank Google Sheet. Safe to re-run — it only creates what's
 * missing and never touches existing rows.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(HEADERS).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    const header = HEADERS[name];
    const firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
    const alreadySet = header.every(function (col, i) { return firstRow[i] === col; });
    if (!alreadySet) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    }
  });

  let readme = ss.getSheetByName(SHEETS.README);
  if (!readme) readme = ss.insertSheet(SHEETS.README);
  readme.clear();
  readme.getRange('A1').setValue('Lead-Gen Autopilot — Script Properties to set');
  readme.getRange('A1').setFontWeight('bold').setFontSize(13);
  const rows = [
    ['Key', 'Required?', 'What it is'],
    ['GEMINI_API_KEY', 'Yes', 'Free key from Google AI Studio (aistudio.google.com/apikey)'],
    ['GEMINI_MODEL', 'No (default gemini-flash-latest)', 'Override if you want a specific Gemini model'],
    ['HUNTER_API_KEY', 'No', 'From hunter.io — enables automatic contact discovery; leave blank to fill Contacts manually'],
    ['BUSINESS_NAME', 'Yes', 'Shown in the email signature/footer'],
    ['PHYSICAL_ADDRESS', 'Yes', 'Required in every outreach email footer (CAN-SPAM / good practice)'],
    ['REPLY_TO_EMAIL', 'Yes', 'adsolutions200@gmail.com — where replies should land'],
    ['NOTIFY_EMAIL', 'No', 'Where "interested" alerts are sent; defaults to REPLY_TO_EMAIL'],
    ['SENDER_ACCOUNTS', 'Yes', 'Comma-separated list of the Gmail addresses that will send, e.g. a@gmail.com,b@gmail.com'],
    ['DAILY_CAP_PER_SENDER', 'No (default 10)', 'Max sends per day per sender account — keep this low, see the plan'],
    ['ICP_FIT_THRESHOLD', 'No (default 60)', '0-100 score below which a lead is not queued for contact/drafting'],
    ['ICP_DESCRIPTION', 'Yes', 'One or two sentences describing who you actually want to reach — used in the classification prompt'],
    ['SEND_WINDOW_START_HOUR', 'No (default 9)', 'Local hour (script timezone) sending may start'],
    ['SEND_WINDOW_END_HOUR', 'No (default 18)', 'Local hour sending must stop'],
    ['SEND_ON_WEEKENDS', 'No (default false)', 'Set to true to allow weekend sends'],
    ['UNSUBSCRIBE_BASE_URL', 'No', 'Web App /exec URL (Deploy > New deployment > Web app) — enables a real one-click unsubscribe header'],
    ['UNSUB_SECRET', 'No, but required if UNSUBSCRIBE_BASE_URL is set', 'Any random string — signs unsubscribe links so they cannot be forged']
  ];
  readme.getRange(3, 1, rows.length, 3).setValues(rows);
  readme.getRange(3, 1, 1, 3).setFontWeight('bold');
  readme.autoResizeColumns(1, 3);
  readme.setColumnWidth(3, 420);

  SpreadsheetApp.flush();
  Logger.log('Sheets ready. Set script properties next: Project Settings > Script Properties.');
}
