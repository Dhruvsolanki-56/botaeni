/**
 * Thin client for the Gemini API free tier (ai.google.dev). Get a key from
 * Google AI Studio and store it as the GEMINI_API_KEY script property —
 * never paste it into source.
 */

function callGemini_(prompt) {
  const config = getConfig();
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY script property is not set.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + config.geminiModel +
    ':generateContent?key=' + encodeURIComponent(config.geminiApiKey);
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 }
  };
  const response = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  }, 3);
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini API error ' + code + ': ' + response.getContentText().substring(0, 500));
  }
  const data = JSON.parse(response.getContentText());
  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
  if (!text) throw new Error('Gemini API returned no text for prompt: ' + prompt.substring(0, 200));
  return text;
}

function callGeminiJson_(prompt) {
  const raw = callGemini_(prompt + '\n\nRespond with ONLY valid JSON. No markdown code fences, no commentary before or after.');
  const cleaned = raw.trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse Gemini JSON output: ' + cleaned.substring(0, 500));
  }
}
