function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setupSheets() first.');
  return sheet;
}

function nowIso_() {
  return new Date().toISOString();
}

function indexMap_(header) {
  const map = {};
  header.forEach(function (name, i) { map[name] = i; });
  return map;
}

function appendRow_(sheetName, rowObject) {
  const sheet = getSheet_(sheetName);
  const header = HEADERS[sheetName];
  const row = header.map(function (col) { return rowObject[col] !== undefined ? rowObject[col] : ''; });
  sheet.appendRow(row);
}

function readSheetAsObjects_(sheetName) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0];
  const rows = values.slice(1);
  return rows.map(function (row, i) {
    const obj = {};
    header.forEach(function (col, c) { obj[col] = row[c]; });
    obj._rowNumber = i + 2; // 1-indexed, +1 for header row
    return obj;
  });
}

function setCell_(sheetName, rowNumber, columnName, value) {
  const sheet = getSheet_(sheetName);
  const header = HEADERS[sheetName];
  const colIndex = header.indexOf(columnName);
  if (colIndex === -1) throw new Error('Column "' + columnName + '" not found in ' + sheetName);
  sheet.getRange(rowNumber, colIndex + 1).setValue(value);
}

function normalizeDomain_(url) {
  if (!url) return '';
  return url.toString().trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function generateLeadId_(companyName, website) {
  const base = normalizeDomain_(website) || companyName;
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(base.toLowerCase()).getBytes()).substring(0, 16);
}

function isSuppressed_(email) {
  if (!email) return true;
  const rows = readSheetAsObjects_(SHEETS.SUPPRESSION);
  const target = email.toString().trim().toLowerCase();
  return rows.some(function (r) { return (r.email || '').toString().trim().toLowerCase() === target; });
}

function addSuppression_(email, reason) {
  if (!email || isSuppressed_(email)) return;
  appendRow_(SHEETS.SUPPRESSION, { email: email, reason: reason, added_at: nowIso_() });
}

function stripHtml_(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchPageText_(url, maxChars) {
  try {
    const fullUrl = /^https?:\/\//.test(url) ? url : 'https://' + url;
    const response = UrlFetchApp.fetch(fullUrl, { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: false });
    if (response.getResponseCode() >= 400) return '';
    return stripHtml_(response.getContentText()).substring(0, maxChars || 3000);
  } catch (e) {
    return '';
  }
}

function logError_(functionName, error, context) {
  try {
    appendRow_(SHEETS.ERRORS, {
      timestamp: nowIso_(),
      function_name: functionName,
      message: (error && error.message) || String(error),
      context: context ? JSON.stringify(context).substring(0, 500) : ''
    });
  } catch (e) {
    // Errors sheet missing or unwritable — don't let logging itself crash the run.
    Logger.log('logError_ failed: ' + e.message);
  }
  Logger.log('[' + functionName + '] ' + ((error && error.message) || error));
}

/**
 * Runs fn() only if the script-wide lock is free, so an overlapping trigger
 * (a run that's still going when the next one fires) can't double-process
 * rows or double-send. Returns fn()'s result, or undefined if the lock
 * couldn't be acquired within LOCK_WAIT_MS.
 */
function withLock_(functionName, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log('[' + functionName + '] skipped — another run still holds the lock.');
    return undefined;
  }
  try {
    return fn();
  } catch (e) {
    logError_(functionName, e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function createTimeBudget_(maxMs) {
  const start = Date.now();
  return { isExpired: function () { return Date.now() - start > (maxMs || MAX_RUN_MS); } };
}

/** Exponential backoff for transient failures (429 / 5xx) from any UrlFetchApp call. */
function fetchWithRetry_(url, options, maxRetries) {
  const retries = maxRetries === undefined ? 3 : maxRetries;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        lastError = new Error('HTTP ' + code + ': ' + response.getContentText().substring(0, 300));
      } else {
        return response;
      }
    } catch (e) {
      lastError = e;
    }
    if (attempt < retries) {
      Utilities.sleep(Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}

function isWithinSendWindow_() {
  const config = getConfig();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const day = Number(Utilities.formatDate(now, tz, 'u')); // 1=Mon..7=Sun
  if (!config.sendOnWeekends && (day === 6 || day === 7)) return false;
  return hour >= config.sendWindowStartHour && hour < config.sendWindowEndHour;
}
