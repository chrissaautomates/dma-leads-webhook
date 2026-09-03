// Pulls leads in from external sources on a schedule: CheckCherry API,
// GHL API, and Google Sheets published-to-web CSVs (Meta Ads / Google Ads).
// Each source is independent and best-effort.

const { upsertLead, findLead, computeTarget } = require('./db');

const status = {};

function recordStatus(name, patch) {
  status[name] = { lastRun: new Date().toISOString(), ...patch };
}

function getSyncStatus() {
  return status;
}

const DEFAULT_TIMEOUT_MS = 15000;

// Shared by every sync function below so one slow/unresponsive source can't
// hang the whole runFullSync() Promise.allSettled forever with no error and
// no log line.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// CheckCherry wraps each lead as { id, type, attributes: {...} } (JSON:API
// style) — the real fields live under attributes, not on the record itself.
// Falls back to the record itself in case the shape ever comes back flat.
function mapCheckCherryLead(record) {
  const attrs = (record && record.attributes) || record || {};

  const name = attrs.name || attrs.full_name
    || [attrs.first_name, attrs.last_name].filter(Boolean).join(' ');

  const venueParts = [attrs.venue_city, attrs.venue_state].filter(Boolean).join(', ');
  const location = attrs.location || venueParts || attrs.city || attrs.venue || attrs.venue_name || '';

  const interest = attrs.interest || attrs.package_name || attrs.service_name
    || attrs.lead_event_type || attrs.event_type || attrs.notes || attrs.message || '';

  let status = attrs.status || 'New';
  if (attrs.spam) status = 'Spam';
  else if (attrs.converted_to_event) status = 'Converted';
  else if (attrs.archived) status = 'Archived';

  return {
    source: 'CheckCherry',
    name,
    company: attrs.company || attrs.company_name || '',
    email: attrs.email || '',
    phone: attrs.phone_normalized || attrs.phone || '',
    location,
    interest,
    status,
    owner: attrs.owner || attrs.assigned_to || '',
    notes: attrs.notes || attrs.message || '',
    nextFollowUp: 'Yes',
  };
}

async function syncCheckCherry() {
  const apiKey = process.env.CHECKCHERRY_API_KEY;
  if (!apiKey) return recordStatus('CheckCherry', { ok: null, error: 'not configured', count: 0 });
  try {
    let page = 1;
    let total = 0;
    for (;;) {
      const url = `https://api.checkcherry.com/api/v1/leads?page=${page}&per=100`;
      const res = await fetchWithTimeout(url, { headers: { 'Api-Key': apiKey } });
      if (!res.ok) throw new Error(`CheckCherry HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const records = Array.isArray(body) ? body : (body.leads || body.data || []);
      if (!records.length) break;
      for (const record of records) {
        const lead = mapCheckCherryLead(record);
        if (!lead.email && !lead.name) continue; // malformed/unmapped record — never write a junk row
        upsertLead(lead);
        total++;
      }
      if (records.length < 100) break;
      page++;
      if (page > 50) break;
    }
    recordStatus('CheckCherry', { ok: true, count: total });
  } catch (err) {
    recordStatus('CheckCherry', { ok: false, error: err.message, count: 0 });
  }
}

// GHL message timestamps aren't guaranteed to come back in a known order —
// sort defensively by whichever timestamp field is present. Messages with
// no recognizable timestamp keep their original relative order (stable
// sort), which is the safest fallback if the API already returned them
// oldest-to-newest.
function sortMessagesOldestFirst(messages) {
  return messages
    .map((m, i) => ({
      m,
      i,
      t: Date.parse(m.dateAdded || m.dateCreated || m.timestamp || m.createdAt || '') || 0,
    }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

const CHAT_TRANSCRIPT_MAX_MESSAGES = 40;
const CHAT_TRANSCRIPT_MAX_CHARS = 6000;

function buildChatTranscript(messages) {
  const ordered = sortMessagesOldestFirst(messages).slice(-CHAT_TRANSCRIPT_MAX_MESSAGES);
  const lines = ordered
    .map((m) => {
      const direction = m.direction === 'outbound' ? 'outbound' : 'inbound';
      const body = (m.body || m.text || '').toString().trim();
      return body ? `${direction}: ${body}` : '';
    })
    .filter(Boolean);
  let transcript = lines.join('\n');
  if (transcript.length > CHAT_TRANSCRIPT_MAX_CHARS) {
    transcript = transcript.slice(-CHAT_TRANSCRIPT_MAX_CHARS); // keep the most recent context
  }
  return transcript;
}

async function fetchGhlChatMessages(apiKey, locationId, contactId) {
  const searchUrl = `https://services.leadconnectorhq.com/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`;
  const searchRes = await fetchWithTimeout(searchUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: 'v3' },
  });
  if (!searchRes.ok) throw new Error(`GHL conversations/search HTTP ${searchRes.status}: ${(await searchRes.text()).slice(0, 300)}`);
  const searchBody = await searchRes.json();
  const conversations = searchBody.conversations || searchBody.data || [];
  const conversationId = conversations[0] && conversations[0].id;
  if (!conversationId) throw new Error('no conversation found for contact');

  const messagesUrl = `https://services.leadconnectorhq.com/conversations/${conversationId}/messages`;
  const messagesRes = await fetchWithTimeout(messagesUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  if (!messagesRes.ok) throw new Error(`GHL messages HTTP ${messagesRes.status}: ${(await messagesRes.text()).slice(0, 300)}`);
  const messagesBody = await messagesRes.json();
  const raw = messagesBody.messages;
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.messages) ? raw.messages : []);
}

async function summarizeChatTranscript(transcript) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!transcript) throw new Error('empty transcript');

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Here is a chat conversation between a lead ("inbound") and us ("outbound"):\n\n${transcript}\n\nIn 2-3 sentences, summarize what the lead is interested in and any next steps discussed. Respond with only the summary as plain text — no heading, no markdown, no preamble.`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = (body.content || []).map((block) => block.text || '').join(' ').trim();
  if (!text) throw new Error('empty summary from Anthropic');
  return text;
}

// Fetches a chat-lead's conversation and summarizes it into notes. Callers
// are expected to wrap this in its own try/catch — a failure here (missing
// conversation, GHL/Anthropic error, timeout) should never fail the rest of
// the GHL sync.
async function summarizeGhlChatLead(apiKey, locationId, contactId) {
  const messages = await fetchGhlChatMessages(apiKey, locationId, contactId);
  const transcript = buildChatTranscript(messages);
  return summarizeChatTranscript(transcript);
}

async function syncGHL() {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return recordStatus('GHL', { ok: null, error: 'not configured', count: 0 });
  try {
    let url = `https://services.leadconnectorhq.com/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`;
    let total = 0;
    for (;;) {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28' },
      });
      if (!res.ok) throw new Error(`GHL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const contacts = body.contacts || [];
      if (!contacts.length) break;
      for (const c of contacts) {
        const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ');
        const email = c.email || '';
        if (!email && !name) continue; // malformed/unmapped record — never write a junk row

        const tags = (c.tags || []).map((t) => String(t).toLowerCase());
        const isChatLead = tags.includes('chat-lead');
        const source = isChatLead ? 'Chat Lead' : 'GHL';
        const interest = (c.tags || []).join(', ');

        let notes = '';
        if (isChatLead) {
          const target = computeTarget({ source, interest });
          const existing = findLead(email, target);
          if (existing && existing.notes) {
            // Already captured this conversation — don't re-fetch/re-summarize.
            notes = existing.notes;
          } else {
            try {
              notes = await summarizeGhlChatLead(apiKey, locationId, c.id);
            } catch (err) {
              console.error(`Chat-lead summarize failed for GHL contact ${c.id}:`, err.message);
              notes = '';
            }
          }
        }

        upsertLead({
          source,
          name,
          company: c.companyName || '',
          email,
          phone: c.phone || '',
          location: c.city || '',
          interest,
          status: 'New',
          owner: '',
          notes,
          nextFollowUp: 'Yes',
        });
        total++;
      }
      const nextId = body.meta && body.meta.startAfterId;
      if (!nextId || contacts.length < 100) break;
      url = `https://services.leadconnectorhq.com/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100&startAfterId=${nextId}`;
    }
    recordStatus('GHL', { ok: true, count: total });
  } catch (err) {
    recordStatus('GHL', { ok: false, error: err.message, count: 0 });
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function pick(obj, aliases) {
  const keys = Object.keys(obj);
  for (const alias of aliases) {
    const key = keys.find((k) => k.trim().toLowerCase() === alias);
    if (key && obj[key]) return obj[key];
  }
  return '';
}

async function syncCsvSheet(envVar, sourceName) {
  const url = process.env[envVar];
  if (!url) return recordStatus(sourceName, { ok: null, error: 'not configured', count: 0 });
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`CSV fetch HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);
    if (rows.length < 2) return recordStatus(sourceName, { ok: true, count: 0 });
    const header = rows[0].map((h) => h.trim());
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const rowObj = {};
      header.forEach((h, idx) => { rowObj[h] = rows[i][idx] || ''; });
      const email = pick(rowObj, ['email', 'email address']);
      const name = pick(rowObj, ['name', 'full name', 'full_name']);
      if (!email && !name) continue; // malformed/unmapped record — never write a junk row
      upsertLead({
        source: sourceName,
        name,
        company: pick(rowObj, ['company', 'company name', 'business name']),
        email,
        phone: pick(rowObj, ['phone', 'phone number']),
        location: pick(rowObj, ['location', 'city']),
        interest: pick(rowObj, ['interest', 'message', 'what are you interested in?', 'request']),
        status: 'New',
        owner: '',
        notes: '',
        nextFollowUp: 'Yes',
      });
      total++;
    }
    recordStatus(sourceName, { ok: true, count: total });
  } catch (err) {
    recordStatus(sourceName, { ok: false, error: err.message, count: 0 });
  }
}

async function runFullSync() {
  await Promise.allSettled([
    syncCheckCherry(),
    syncGHL(),
    syncCsvSheet('META_ADS_CSV_URL', 'Meta Ads'),
    syncCsvSheet('GOOGLE_ADS_CSV_URL', 'Google Ads'),
  ]);
  return getSyncStatus();
}

module.exports = { runFullSync, getSyncStatus };
