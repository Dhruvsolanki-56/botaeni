'use strict';
/**
 * A from-scratch mock of the Apps Script runtime (SpreadsheetApp, GmailApp,
 * UrlFetchApp, PropertiesService, etc.) so the actual .gs files in
 * apps-script/ can run, unmodified, inside a plain Node vm context. This is
 * what lets test/*.test.js exercise the real production logic — sheet I/O,
 * suppression checks, round-robin assignment, retry/backoff, locking — with
 * no network calls and no Google account.
 *
 * Deliberate simplification: formatDate below reads UTC getters and ignores
 * the timezone argument entirely. That's fine for testing branch logic
 * (hour/day comparisons) — it is NOT a substitute for verifying real
 * Asia/Kolkata behavior, which only Apps Script itself can do.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const APPS_SCRIPT_DIR = path.join(__dirname, '..', 'apps-script');

const ALL_FILES = [
  'Config.gs', 'Utils.gs', 'Gemini.gs', 'SheetSetup.gs', 'Sourcing.gs',
  'Classification.gs', 'ContactDiscovery.gs', 'Personalization.gs',
  'Unsubscribe.gs', 'MimeMail.gs', 'Sender.gs', 'ReplyHandler.gs',
  'Triggers.gs', 'SelfTest.gs', 'Dashboard.gs', 'DashboardHtml.gs', 'WebApp.gs'
];

function makeSheet(name) {
  let data = [];
  const sheet = {
    getName: () => name,
    getRange(row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const rowArr = data[row - 1 + r] || [];
            const outRow = [];
            for (let c = 0; c < numCols; c++) outRow.push(rowArr[col - 1 + c] !== undefined ? rowArr[col - 1 + c] : '');
            out.push(outRow);
          }
          return out;
        },
        setValues(values) {
          values.forEach((rowArr, r) => {
            const idx = row - 1 + r;
            if (!data[idx]) data[idx] = [];
            rowArr.forEach((v, c) => { data[idx][col - 1 + c] = v; });
          });
          return this;
        },
        setValue(v) {
          if (!data[row - 1]) data[row - 1] = [];
          data[row - 1][col - 1] = v;
          return this;
        },
        setFontWeight() { return this; },
        setFontSize() { return this; }
      };
    },
    getDataRange() {
      const numRows = data.length;
      const numCols = data.reduce((max, r) => Math.max(max, r.length), 0);
      return sheet.getRange(1, 1, numRows, numCols);
    },
    appendRow(rowArr) { data.push(rowArr.slice()); },
    setFrozenRows() { return this; },
    autoResizeColumns() { return this; },
    setColumnWidth() { return this; },
    clear() { data = []; return this; },
    getLastRow: () => data.length,
    _rows: () => data
  };
  return sheet;
}

function makeSpreadsheet() {
  const sheets = new Map();
  return {
    getSheetByName: (name) => (sheets.has(name) ? sheets.get(name) : null),
    insertSheet(name) { const s = makeSheet(name); sheets.set(name, s); return s; },
    _sheets: sheets
  };
}

function makePropertiesService(initial) {
  const store = new Map(Object.entries(initial || {}));
  const api = {
    getProperty: (key) => (store.has(key) ? store.get(key) : null),
    setProperty(key, value) { store.set(key, String(value)); return api; },
    getProperties: () => Object.fromEntries(store),
    deleteProperty(key) { store.delete(key); return api; }
  };
  return { getScriptProperties: () => api };
}

function makeUtilities() {
  return {
    base64EncodeWebSafe: (str) => Buffer.from(str, 'utf8').toString('base64url'),
    base64Encode: (str) => Buffer.from(str, 'utf8').toString('base64'),
    newBlob: (str) => ({ getBytes: () => Buffer.from(str, 'utf8') }),
    sleep: () => {},
    formatDate(date, tz, pattern) {
      const d = new Date(date);
      if (pattern === 'yyyy-MM-dd') return d.toISOString().slice(0, 10);
      if (pattern === 'H') return String(d.getUTCHours());
      if (pattern === 'u') { const day = d.getUTCDay(); return String(day === 0 ? 7 : day); }
      return d.toISOString();
    },
    computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', key).update(value).digest()),
    Charset: { UTF_8: 'UTF-8' }
  };
}

function makeSession(email, tz) {
  return {
    getActiveUser: () => ({ getEmail: () => email }),
    getScriptTimeZone: () => tz || 'Etc/UTC'
  };
}

function makeUrlFetchApp(handler) {
  return { fetch: (url, options) => handler(url, options) };
}

function makeResponse(code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

function makeGmailApp(state) {
  return {
    sendEmail(to, subject, body, options) { state.sentEmails.push({ to, subject, body, options }); },
    search: (query) => state.searchResults[query] || [],
    getRemainingDailyQuota: () => 100
  };
}

function makeMessage({ id, plainBody, date, isDraftFlag }) {
  return {
    getId: () => id,
    getPlainBody: () => plainBody,
    getDate: () => date || new Date(),
    isDraft: () => !!isDraftFlag
  };
}

function makeThread(messages) {
  return { getMessages: () => messages };
}

function makeGmailAdvanced(state) {
  return {
    Users: {
      Messages: {
        send(resource, userId) {
          state.apiSent.push({ resource, userId });
          return { id: 'fake-msg-' + state.apiSent.length };
        }
      }
    }
  };
}

function makeScriptApp() {
  let triggers = [];
  const builder = (handlerFunctionName) => ({
    timeBased: () => ({
      everyHours: (n) => ({ create: () => { const t = { handlerFunctionName, type: 'hours', n }; triggers.push(t); return t; } }),
      everyMinutes: (n) => ({ create: () => { const t = { handlerFunctionName, type: 'minutes', n }; triggers.push(t); return t; } })
    })
  });
  return {
    newTrigger: (name) => builder(name),
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
    _triggers: () => triggers
  };
}

function makeLockService(options) {
  options = options || {};
  let locked = false;
  return {
    getScriptLock: () => ({
      tryLock: () => {
        if (options.alwaysFail) return false;
        if (locked) return false;
        locked = true;
        return true;
      },
      releaseLock: () => { locked = false; }
    })
  };
}

function makeHtmlOutput(html) {
  const out = {
    _title: '',
    _meta: [],
    getContent: () => html,
    getTitle: () => out._title,
    setTitle(t) { out._title = t; return out; },
    addMetaTag(name, content) { out._meta.push({ name, content }); return out; }
  };
  return out;
}

function makeFakeDateClass(fixedNow) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixedNow.getTime());
      else super(...args);
    }
    static now() { return fixedNow.getTime(); }
  };
}

/**
 * overrides:
 *   properties        - initial Script Properties, e.g. { GEMINI_API_KEY: 'x' }
 *   fetchHandler       - (url, options) => mockResponse, required if code under test calls UrlFetchApp
 *   activeUserEmail    - Session.getActiveUser().getEmail()
 *   timeZone           - Session.getScriptTimeZone()
 *   now                - fixed Date the sandbox's `new Date()` should return
 *   gmailAdvancedEnabled - inject the `Gmail` advanced-service global
 *   lock               - { alwaysFail: true } to simulate a held lock
 *   searchResults      - { [gmailSearchQuery]: [thread, ...] } for GmailApp.search
 *   files              - override which .gs files to load (default: all)
 */
function createEnv(overrides) {
  overrides = overrides || {};
  const state = { sentEmails: [], apiSent: [], logs: [], searchResults: overrides.searchResults || {} };
  const spreadsheet = makeSpreadsheet();

  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => {} },
    PropertiesService: makePropertiesService(overrides.properties),
    Utilities: makeUtilities(),
    UrlFetchApp: makeUrlFetchApp(overrides.fetchHandler || (() => { throw new Error('No fetchHandler configured for this test'); })),
    Session: makeSession(overrides.activeUserEmail || 'main@gmail.com', overrides.timeZone),
    GmailApp: makeGmailApp(state),
    MailApp: { getRemainingDailyQuota: () => (overrides.mailQuota !== undefined ? overrides.mailQuota : 100) },
    ScriptApp: makeScriptApp(),
    LockService: makeLockService(overrides.lock),
    Logger: { log: (msg) => state.logs.push(String(msg)) },
    ContentService: { createTextOutput: (t) => ({ getContent: () => t }) },
    HtmlService: { createHtmlOutput: (h) => makeHtmlOutput(h) }
  };

  if (overrides.gmailAdvancedEnabled) sandbox.Gmail = makeGmailAdvanced(state);
  if (overrides.now) sandbox.Date = makeFakeDateClass(overrides.now);

  const context = vm.createContext(sandbox);
  (overrides.files || ALL_FILES).forEach((file) => {
    const code = fs.readFileSync(path.join(APPS_SCRIPT_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });

  return { context, spreadsheet, state };
}

function geminiResponse(text) {
  return makeResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });
}

function promptFromGeminiPayload(options) {
  const body = JSON.parse(options.payload);
  return body.contents[0].parts[0].text;
}

module.exports = { createEnv, makeResponse, makeMessage, makeThread, geminiResponse, promptFromGeminiPayload };
