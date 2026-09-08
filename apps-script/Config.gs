/**
 * All tunables live in Script Properties (Extensions > Apps Script > Project
 * Settings > Script Properties), never hardcoded here, so the same code works
 * across every sender account's deployment without editing source.
 */

var SHEETS = {
  RAW_LEADS: 'RawLeads',
  CLASSIFIED: 'Classified',
  CONTACTS: 'Contacts',
  DRAFTS: 'Drafts',
  SEND_QUEUE: 'SendQueue',
  SENT_LOG: 'SentLog',
  REPLIES: 'Replies',
  SUPPRESSION: 'Suppression',
  ERRORS: 'Errors',
  README: 'ReadMe',
  SOURCE_QUERIES: 'SourceQueries'
};

var HEADERS = {
  RawLeads: ['lead_id', 'source', 'company_name', 'website', 'category', 'address', 'phone', 'added_at', 'status'],
  SourceQueries: ['category', 'osm_tag', 'location', 'area_id', 'last_run_at', 'total_found', 'enabled'],
  Classified: ['lead_id', 'industry', 'sub_vertical', 'company_size_estimate', 'icp_fit_score', 'likely_decision_maker_title', 'pitch_angle', 'evidence_snippet', 'confidence', 'classified_at'],
  Contacts: ['lead_id', 'contact_name', 'contact_title', 'contact_email', 'verification_status', 'source', 'found_at'],
  Drafts: ['lead_id', 'contact_email', 'subject', 'body', 'status', 'created_at', 'reviewed_at'],
  SendQueue: ['lead_id', 'contact_email', 'subject', 'body', 'assigned_sender', 'sequence_step', 'status', 'queued_at'],
  SentLog: ['lead_id', 'contact_email', 'sender', 'subject', 'sequence_step', 'sent_at', 'status'],
  Replies: ['lead_id', 'contact_email', 'message_id', 'received_at', 'snippet', 'category', 'urgency', 'suggested_action', 'key_question_or_objection'],
  Suppression: ['email', 'reason', 'added_at'],
  Errors: ['timestamp', 'function_name', 'message', 'context']
};

var MAX_RUN_MS = 4.5 * 60 * 1000; // leave headroom under Apps Script's 6-minute execution ceiling
var LOCK_WAIT_MS = 5000;

function getProp_(key, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return (value === null || value === undefined || value === '') ? fallback : value;
}

function getConfig() {
  return {
    groqApiKey: getProp_('GROQ_API_KEY', ''),
    groqModel: getProp_('GROQ_MODEL', 'openai/gpt-oss-20b'),
    hunterApiKey: getProp_('HUNTER_API_KEY', ''),
    businessName: getProp_('BUSINESS_NAME', 'AdSolutions'),
    physicalAddress: getProp_('PHYSICAL_ADDRESS', 'REPLACE_WITH_YOUR_MAILING_ADDRESS'),
    replyToEmail: getProp_('REPLY_TO_EMAIL', 'adsolutions200@gmail.com'),
    notifyEmail: getProp_('NOTIFY_EMAIL', getProp_('REPLY_TO_EMAIL', 'adsolutions200@gmail.com')),
    senderAccounts: getProp_('SENDER_ACCOUNTS', '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    dailyCapPerSender: Number(getProp_('DAILY_CAP_PER_SENDER', '10')),
    icpFitThreshold: Number(getProp_('ICP_FIT_THRESHOLD', '60')),
    icpDescription: getProp_('ICP_DESCRIPTION', 'Small and mid-size businesses that would benefit from paid ad management and digital marketing services.'),
    sendWindowStartHour: Number(getProp_('SEND_WINDOW_START_HOUR', '9')),
    sendWindowEndHour: Number(getProp_('SEND_WINDOW_END_HOUR', '18')),
    sendOnWeekends: getProp_('SEND_ON_WEEKENDS', 'false') === 'true',
    unsubscribeBaseUrl: getProp_('UNSUBSCRIBE_BASE_URL', ''), // Web App /exec URL — enables real one-click List-Unsubscribe-Post
    unsubscribeSecret: getProp_('UNSUB_SECRET', '')
  };
}

var REQUIRED_CONFIG_KEYS = ['GROQ_API_KEY', 'BUSINESS_NAME', 'PHYSICAL_ADDRESS', 'REPLY_TO_EMAIL', 'SENDER_ACCOUNTS', 'ICP_DESCRIPTION'];

function validateConfig_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const missing = REQUIRED_CONFIG_KEYS.filter(function (k) { return !props[k]; });
  if (missing.length > 0) {
    throw new Error('Missing required Script Properties: ' + missing.join(', '));
  }
}
