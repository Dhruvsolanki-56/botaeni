/**
 * Production sending path: builds a raw MIME message with a real
 * List-Unsubscribe header and sends it via the Gmail advanced service, so
 * Gmail can render its native one-click "Unsubscribe" pill (this is what
 * actually lowers spam-complaint rates — see the plan, §01/§07).
 *
 * Requires the "Gmail API" advanced service enabled for this project
 * (Services (+) > Gmail API, in the Apps Script editor — do this in every
 * sending account's deployment). If it isn't enabled yet, this falls back
 * to plain GmailApp.sendEmail automatically so sending never breaks.
 */
function sendProductionEmail_(to, subject, bodyText, config) {
  const unsubUrl = buildUnsubscribeUrl_(to, config);
  const fullBody = bodyText + buildFooter_(config, unsubUrl);

  if (isGmailAdvancedServiceAvailable_()) {
    try {
      return sendViaGmailApiWithHeaders_(to, subject, fullBody, config, unsubUrl);
    } catch (e) {
      logError_('sendProductionEmail_/gmailApi', e, { to: to });
      // fall through to the plain GmailApp path below
    }
  }
  GmailApp.sendEmail(to, subject, fullBody, { replyTo: config.replyToEmail, name: config.businessName });
}

function isGmailAdvancedServiceAvailable_() {
  return typeof Gmail !== 'undefined' && !!(Gmail && Gmail.Users && Gmail.Users.Messages);
}

function sendViaGmailApiWithHeaders_(to, subject, body, config, unsubUrl) {
  const listUnsubscribe = unsubUrl
    ? '<' + unsubUrl + '>, <mailto:' + config.replyToEmail + '?subject=unsubscribe>'
    : '<mailto:' + config.replyToEmail + '?subject=unsubscribe>';

  const headerLines = [
    'To: ' + to,
    'From: ' + config.businessName + ' <' + config.replyToEmail + '>',
    'Reply-To: ' + config.replyToEmail,
    'Subject: =?UTF-8?B?' + Utilities.base64Encode(subject, Utilities.Charset.UTF_8) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    'List-Unsubscribe: ' + listUnsubscribe
  ];
  if (unsubUrl) headerLines.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');

  const raw = headerLines.join('\r\n') + '\r\n\r\n' + body;
  const encoded = Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
  return Gmail.Users.Messages.send({ raw: encoded }, 'me');
}

function buildFooter_(config, unsubUrl) {
  const unsubscribeLine = unsubUrl
    ? 'Don\'t want future emails? Unsubscribe: ' + unsubUrl
    : 'Don\'t want future emails from us? Just reply "unsubscribe" — we remove you immediately, by hand, every time.';
  return [
    '', '', '---',
    config.businessName,
    config.physicalAddress,
    unsubscribeLine
  ].join('\n');
}
