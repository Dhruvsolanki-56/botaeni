/**
 * Optional but recommended for production: deploy this project as a Web App
 * (Deploy > New deployment > Web app, execute as "Me", access "Anyone")
 * and put its /exec URL into the UNSUBSCRIBE_BASE_URL script property, plus
 * any random string into UNSUB_SECRET. Once both are set, MimeMail.gs
 * switches from a plain mailto: List-Unsubscribe header to a real RFC 8058
 * one-click HTTPS unsubscribe — Gmail POSTs to this endpoint automatically
 * when the recipient clicks its native "Unsubscribe" pill, no page load,
 * no confirmation click. Without those two properties set, sending still
 * works fine with the mailto fallback — this is additive, not required.
 */
function buildUnsubscribeUrl_(email, config) {
  if (!config.unsubscribeBaseUrl || !config.unsubscribeSecret) return '';
  const token = signUnsubscribeToken_(email, config.unsubscribeSecret);
  return config.unsubscribeBaseUrl + '?email=' + encodeURIComponent(email) + '&token=' + token;
}

function signUnsubscribeToken_(email, secret) {
  const raw = Utilities.computeHmacSha256Signature(email.toLowerCase().trim(), secret);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function handleUnsubscribeRequest_(params) {
  const config = getConfig();
  const email = params.email;
  const token = params.token;
  if (!email || !token) return 'Missing email or token.';
  if (!config.unsubscribeSecret || signUnsubscribeToken_(email, config.unsubscribeSecret) !== token) {
    return 'Invalid or expired unsubscribe link.';
  }
  addSuppression_(email, 'one_click_unsubscribe');
  return 'You have been unsubscribed and will not receive further emails from us.';
}

function doPost(e) {
  const message = handleUnsubscribeRequest_((e && e.parameter) || {});
  return ContentService.createTextOutput(message);
}

function doGet(e) {
  const message = handleUnsubscribeRequest_((e && e.parameter) || {});
  return HtmlService.createHtmlOutput('<p>' + message + '</p>');
}
