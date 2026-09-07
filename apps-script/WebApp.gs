/**
 * Single Web App entry point (Deploy > New deployment > Web app). Routes:
 *   ?email=&token=   -> one-click unsubscribe (GET fallback; Gmail's real
 *                        one-click flow uses POST, handled below)
 *   ?key=<your key>  -> the dashboard, gated by DASHBOARD_ACCESS_KEY
 *   anything else     -> a plain message, so the URL never leaks data to
 *                        someone who just stumbles onto it
 *
 * Set DASHBOARD_ACCESS_KEY as a script property (any random string) and
 * bookmark the deployed URL with ?key=<that string> appended. Without it
 * set, the dashboard refuses to render — the sheet holds real prospect
 * emails and reply text, so "anyone with the link" is not an acceptable
 * default the way it is for the unsubscribe path.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.email && params.token) {
    return HtmlService.createHtmlOutput('<p>' + handleUnsubscribeRequest_(params) + '</p>');
  }

  const requiredKey = getProp_('DASHBOARD_ACCESS_KEY', '');
  if (!requiredKey || params.key !== requiredKey) {
    return HtmlService.createHtmlOutput('<p>Not found.</p>');
  }

  return HtmlService.createHtmlOutput(renderDashboardHtml_())
    .setTitle('Lead-Gen Autopilot Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  const message = handleUnsubscribeRequest_((e && e.parameter) || {});
  return ContentService.createTextOutput(message);
}
