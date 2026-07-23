/**
 * Agent Reviewer — Phase 2.
 * User-configured panel of 2–5 agents. Run Review -> all agents review in
 * parallel (fetchAll) -> matched passages highlighted per-agent-color -> sidebar.
 *
 * Setup:
 *   1. Extensions > Apps Script inside a Google Doc (bound), OR clasp push.
 *   2. Paste Code.gs, Sidebar.html, appsscript.json.
 *   3. Sidebar: paste Gemini API key -> Save. Paste agent config JSON -> Save.
 *   4. Reload doc -> "Agent Reviewer" menu -> Open Reviewer -> Run Review.
 */

// --- Config -----------------------------------------------------------------

// VERIFY current model name in Google AI Studio before relying on this.
const GEMINI_MODEL = 'gemini-2.0-flash';

// Highlight colors, assigned per agent by index.
const COLORS = ['#fff2a8', '#d9ead3', '#cfe2f3', '#f4cccc', '#ead1dc'];

// Seed config shown on first run (also the "example").
const DEFAULT_AGENTS = [
  {
    name: 'Skeptic',
    persona: 'You are a relentless skeptic. You challenge assumptions, expose weak ' +
             'reasoning, and flag claims made without evidence. Direct and specific.'
  },
  {
    name: 'CFO — Risk Averse',
    persona: 'You are a conservative CFO. You scrutinize costs, demand clear ROI, ' +
             'identify financial risks, and push back on initiatives without a solid ' +
             'business case.'
  }
];

// --- Menu + sidebar ---------------------------------------------------------

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Agent Reviewer')
    .addItem('Open Reviewer', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Agent Reviewer');
  DocumentApp.getUi().showSidebar(html);
}

// --- API key (user properties) ---------------------------------------------

function saveApiKey(key) {
  PropertiesService.getUserProperties().setProperty('GEMINI_KEY', (key || '').trim());
  return true;
}

function hasApiKey() {
  return !!PropertiesService.getUserProperties().getProperty('GEMINI_KEY');
}

function getApiKey_() {
  const k = PropertiesService.getUserProperties().getProperty('GEMINI_KEY');
  if (!k) throw new Error('No Gemini API key saved. Paste it in the sidebar and Save.');
  return k;
}

// --- Agent config (user properties) ----------------------------------------

/** Parse + validate a config JSON string. Throws with a specific message. */
function parseAgents_(json) {
  let arr;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    throw new Error('Not valid JSON: ' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('Config must be a JSON array.');
  if (arr.length < 2 || arr.length > 5) {
    throw new Error('Need 2–5 agents (got ' + arr.length + ').');
  }
  arr.forEach(function (a, i) {
    if (!a || typeof a !== 'object') throw new Error('Agent ' + (i + 1) + ' is not an object.');
    if (!a.name || !String(a.name).trim()) throw new Error('Agent ' + (i + 1) + ' missing "name".');
    if (!a.persona || !String(a.persona).trim()) {
      throw new Error('Agent ' + (i + 1) + ' ("' + (a.name || '?') + '") missing "persona".');
    }
  });
  return arr;
}

/** Validate only (Validate button). Returns {ok, count} or {ok:false, error}. */
function validateAgents(json) {
  try {
    const arr = parseAgents_(json);
    return { ok: true, count: arr.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Validate + store. Returns {ok, count} or {ok:false, error}. */
function saveAgents(json) {
  try {
    const arr = parseAgents_(json);
    PropertiesService.getUserProperties().setProperty('AGENTS_JSON', JSON.stringify(arr));
    return { ok: true, count: arr.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** For the settings UI: current stored config (or the seed default), pretty-printed. */
function getAgentsConfig() {
  const stored = PropertiesService.getUserProperties().getProperty('AGENTS_JSON');
  const arr = stored ? JSON.parse(stored) : DEFAULT_AGENTS;
  return { json: JSON.stringify(arr, null, 2), count: arr.length, seeded: !stored };
}

/** For review: the agents to run (stored, else seed). */
function getAgents_() {
  const stored = PropertiesService.getUserProperties().getProperty('AGENTS_JSON');
  return stored ? JSON.parse(stored) : DEFAULT_AGENTS;
}

// --- Main: run review (all agents, parallel) --------------------------------

/**
 * Returns { threads:[thread], errors:[string] }
 * thread = { id, agent, persona, color, quoted, comment, found, messages:[{role,text}] }
 * One agent failing (bad API response) does not kill the others.
 */
function runReview() {
  const body = DocumentApp.getActiveDocument().getBody();
  const docText = body.getText();
  if (!docText || docText.trim().length < 20) {
    return { error: 'Document is empty or too short to review.' };
  }

  const agents = getAgents_();
  const apiKey = getApiKey_();

  // One request per agent, all fired together (avoids the 6-min sequential ceiling).
  const requests = agents.map(function (a) {
    return buildGeminiRequest_(a.persona, docText, apiKey);
  });
  const responses = fetchAllWithRetry_(requests);

  clearHighlights_(body);  // reset highlights
  clearThreads_();         // drop the previous run's conversations

  const threads = [];
  const errors = [];
  const ids = [];

  agents.forEach(function (a, idx) {
    const color = COLORS[idx % COLORS.length];
    let items;
    try {
      items = extractItems_(responses[idx]);
    } catch (e) {
      errors.push(a.name + ': ' + e.message);
      return;
    }
    items.forEach(function (it) {
      const quoted = (it.quoted_text || '').trim();
      const comment = (it.comment || '').trim();
      if (!quoted || !comment) return;

      const found = highlightPassage_(body, quoted, color);
      const t = {
        id: Utilities.getUuid(),
        agent: a.name,
        persona: a.persona,     // snapshot so later dialogue is stable if config changes
        color: color,
        quoted: quoted,
        comment: comment,
        found: found,
        messages: [{ role: 'agent', text: comment }]
      };
      saveThread_(t);
      ids.push(t.id);
      threads.push(t);
    });
  });

  PropertiesService.getDocumentProperties().setProperty('THREAD_IDS', JSON.stringify(ids));
  return { threads: threads, errors: errors };
}

// --- Dialogue (sidebar threads) ---------------------------------------------

/**
 * Continue a thread. buttonType: 'explain' | 'why' | 'continue'.
 * For 'continue', userReply is the user's typed message (appended before the call).
 * Returns { ok:true, thread } or throws.
 */
function continueThread(threadId, buttonType, userReply) {
  const t = loadThread_(threadId);
  if (!t) throw new Error('Thread not found (was it cleared by a new review?).');
  const apiKey = getApiKey_();
  const docText = DocumentApp.getActiveDocument().getBody().getText();

  if (buttonType === 'continue' && userReply && userReply.trim()) {
    t.messages.push({ role: 'user', text: userReply.trim() });
  }

  const prompt = buildContinuationPrompt_(t, buttonType, docText);
  const reply = callGeminiText_(prompt, apiKey);

  t.messages.push({ role: 'agent', text: reply });
  saveThread_(t);
  return { ok: true, thread: t };
}

function buildContinuationPrompt_(t, buttonType, docText) {
  const history = t.messages.map(function (m) {
    return (m.role === 'user' ? 'User' : t.agent) + ': ' + m.text;
  }).join('\n');

  return 'You are continuing a conversation as a document reviewer. Your perspective:\n\n' +
    t.persona + '\n\n' +
    'You previously commented on this passage: "' + t.quoted + '"\n\n' +
    'The conversation so far:\n' + history + '\n\n' +
    'The user clicked: ' + buttonType + '\n' +
    '- If "explain": Clarify your feedback in simpler terms. Why does this matter?\n' +
    '- If "why": Elaborate on the reasoning. What assumptions or evidence led you here?\n' +
    '- If "continue": Respond naturally to the user\'s most recent reply.\n\n' +
    'Keep your response concise (2-4 sentences). Stay in character.\n\n' +
    'Current document for context:\n' + docText;
}

/** Restore threads on sidebar reload. */
function getThreads() {
  const idx = PropertiesService.getDocumentProperties().getProperty('THREAD_IDS');
  if (!idx) return [];
  return JSON.parse(idx).map(loadThread_).filter(Boolean);
}

// --- Thread storage (document properties, per-doc) --------------------------

function saveThread_(t) {
  PropertiesService.getDocumentProperties().setProperty('thread_' + t.id, JSON.stringify(t));
}

function loadThread_(id) {
  const s = PropertiesService.getDocumentProperties().getProperty('thread_' + id);
  return s ? JSON.parse(s) : null;
}

function clearThreads_() {
  const props = PropertiesService.getDocumentProperties();
  const idx = props.getProperty('THREAD_IDS');
  if (idx) {
    JSON.parse(idx).forEach(function (id) { props.deleteProperty('thread_' + id); });
  }
  props.deleteProperty('THREAD_IDS');
}

// --- Gemini ------------------------------------------------------------------

function buildGeminiRequest_(persona, docText, apiKey) {
  const prompt =
    'You are reviewing a document as a critical reader. Your perspective:\n\n' +
    persona + '\n\n' +
    'Instructions:\n' +
    '- Identify 3-7 specific passages that warrant feedback from your perspective.\n' +
    '- For each, quote the EXACT phrase from the document, verbatim, under 15 words.\n' +
    '- Focus on substance: weak reasoning, missing considerations, flawed assumptions.\n' +
    '- Do not nitpick grammar. Be direct and specific about what is wrong and why.\n' +
    '- Match the tone of your persona.\n\n' +
    'Return ONLY a JSON array of objects with keys "quoted_text" and "comment".\n\n' +
    'Document to review:\n' + docText;

  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' +
         GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey),
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: 'application/json' }
    }),
    muteHttpExceptions: true
  };
}

/** Parse one agent's HTTPResponse into [{quoted_text, comment}]. Throws on failure. */
function extractItems_(resp) {
  const text = modelText_(resp);  // throws with a specific message on error/block

  let items;
  try {
    items = JSON.parse(text);
  } catch (e) {
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    items = JSON.parse(cleaned);
  }
  return Array.isArray(items) ? items : [];
}

/** Single prose completion (used by dialogue — no JSON coercion). */
function callGeminiText_(prompt, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const resp = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 }
    }),
    muteHttpExceptions: true
  });
  return modelText_(resp).trim();
}

/**
 * Pull the model's text from a Gemini HTTPResponse, or throw a specific error:
 * non-200, prompt-level block, empty candidates, or a non-STOP finishReason
 * (e.g. SAFETY, MAX_TOKENS) with no usable content.
 */
function modelText_(resp) {
  const code = resp.getResponseCode();
  const raw = resp.getContentText();
  if (code !== 200) throw new Error('API ' + code + ': ' + raw.slice(0, 180));

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('non-JSON response: ' + raw.slice(0, 150)); }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error('prompt blocked (' + data.promptFeedback.blockReason + ')');
  }
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new Error('no candidates returned');

  const parts = cand.content && cand.content.parts;
  if (!parts || !parts[0] || parts[0].text === undefined) {
    throw new Error('empty content' + (cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
  }
  return parts[0].text;
}

// --- Rate-limit retry (exponential backoff + jitter) ------------------------

const MAX_RETRIES = 3;

function backoff_(attempt) {
  const base = 800 * Math.pow(2, attempt - 1);     // 800ms, 1.6s, 3.2s
  return Math.min(base, 8000) + Math.floor(Math.random() * 400);
}

/** fetchAll with per-request retry of 429/503 only. Order preserved. */
function fetchAllWithRetry_(requests) {
  const out = new Array(requests.length);
  let pending = requests.map(function (r, i) { return { r: r, i: i }; });

  for (let attempt = 0; ; attempt++) {
    const resps = UrlFetchApp.fetchAll(pending.map(function (p) { return p.r; }));
    const retry = [];
    for (let k = 0; k < resps.length; k++) {
      const resp = resps[k], idx = pending[k].i, code = resp.getResponseCode();
      out[idx] = resp; // keep latest
      if ((code === 429 || code === 503) && attempt < MAX_RETRIES) retry.push(pending[k]);
    }
    if (!retry.length) return out;
    Utilities.sleep(backoff_(attempt + 1));
    pending = retry;
  }
}

/** Single fetch with retry of 429/503. */
function fetchWithRetry_(url, options) {
  for (let attempt = 0; ; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if ((code !== 429 && code !== 503) || attempt >= MAX_RETRIES) return resp;
    Utilities.sleep(backoff_(attempt + 1));
  }
}

// --- Highlight matching (hardened) ------------------------------------------

// Quote / dash / ellipsis variants. Literal unicode chars (RE2-safe in a class).
const DQUOTES = '"“”„‟';        // " “ ” „ ‟
const SQUOTES = "'‘’‚‛′";  // ' ‘ ’ ‚ ‛ ′
const DASHES  = '-‐‑‒–—―'; // - ‐ ‑ ‒ – — ―

function highlightPassage_(body, quoted, color) {
  const range = findPassage_(body, quoted);
  if (!range) return false;
  const el = range.getElement();
  if (!el.editAsText) return false;
  el.asText().setBackgroundColor(range.getStartOffset(), range.getEndOffsetInclusive(), color);
  return true;
}

/**
 * Fallback ladder — first hit wins:
 *   1. whole phrase, fuzzy
 *   2. strip wrapping quotes + edge ellipsis
 *   3. longest chunk if the LLM elided the middle with "..."
 *   4. first 8 words
 */
function findPassage_(body, quoted) {
  let p = quoted.trim();

  let r = findFuzzy_(body, p);
  if (r) return r;

  const stripped = normalizeText_(p)
    .replace(/^["']+|["']+$/g, '')
    .replace(/^\.\.\.|\.\.\.$/g, '')
    .trim();
  if (stripped && stripped !== p) {
    r = findFuzzy_(body, stripped);
    if (r) return r;
    p = stripped;
  }

  if (p.indexOf('...') !== -1) {
    const chunk = p.split(/\.\.\./)
      .map(function (s) { return s.trim(); })
      .sort(function (a, b) { return b.length - a.length; })[0];
    if (chunk && chunk.split(/\s+/).length >= 3) {
      r = findFuzzy_(body, chunk);
      if (r) return r;
    }
  }

  const head = p.split(/\s+/).slice(0, 8).join(' ');
  if (head && head !== p) {
    r = findFuzzy_(body, head);
    if (r) return r;
  }
  return null;
}

/** Normalize quote/dash/ellipsis/nbsp variants to canonical forms. */
function normalizeText_(s) {
  return String(s)
    .replace(new RegExp('[' + DQUOTES + ']', 'g'), '"')
    .replace(new RegExp('[' + SQUOTES + ']', 'g'), "'")
    .replace(new RegExp('[' + DASHES + ']', 'g'), '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

/** Build a RE2 pattern tolerant of quote/dash/whitespace variance, then findText. */
function findFuzzy_(body, phrase) {
  const norm = normalizeText_(phrase).trim();
  if (!norm) return null;

  let pat = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (/\s/.test(c)) {
      pat += '\\s+';
      while (i + 1 < norm.length && /\s/.test(norm[i + 1])) i++;
    } else if (c === '"') {
      pat += '[' + DQUOTES + ']';
    } else if (c === "'") {
      pat += '[' + SQUOTES + ']';
    } else if (c === '-') {
      pat += '[' + DASHES + ']';
    } else if ('.*+?^${}()|[]\\'.indexOf(c) !== -1) {
      pat += '\\' + c;
    } else {
      pat += c;
    }
  }
  try {
    return body.findText(pat);
  } catch (e) {
    return null;
  }
}

/** Clear background color across the whole body so re-runs don't stack. */
function clearHighlights_(body) {
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const el = body.getChild(i);
    if (el.editAsText) {
      const t = el.asText();
      if (t.getText().length > 0) t.setBackgroundColor(0, t.getText().length - 1, null);
    }
  }
}
