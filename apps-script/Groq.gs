/**
 * Thin client for Groq's free tier (console.groq.com) — genuinely free,
 * no card required, 14,400 requests/day. Used instead of Gemini because
 * Gemini's free tier now requires a billing account on file for some
 * accounts (see the plan's notes on this). Function names stay
 * callGemini_/callGeminiJson_ since every other file already calls them —
 * only what's inside changed.
 *
 * Get a key from console.groq.com (sign in with any Google account — this
 * is a Groq account, unrelated to Google Cloud billing) and store it as
 * the GROQ_API_KEY script property — never paste it into source.
 */

function callGemini_(prompt) {
  const config = getConfig();
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY script property is not set.');
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const payload = {
    model: config.groqModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4
  };
  const response = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.groqApiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  }, 3);
  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Groq API error ' + code + ': ' + response.getContentText().substring(0, 500));
  }
  const data = JSON.parse(response.getContentText());
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('Groq API returned no text for prompt: ' + prompt.substring(0, 200));
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
    throw new Error('Could not parse Groq JSON output: ' + cleaned.substring(0, 500));
  }
}
