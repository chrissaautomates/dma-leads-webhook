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

// Shared by every outbound call in this file so one slow/unresponsive
// source can't hang the whole runFullSync() Promise.allSettled forever with
// no error and no log line.
//
// IMPORTANT: this reads the full response body here too, inside the same
// timeout window. fetch() resolving only means response headers arrived —
// a stalled/slow-streaming body would otherwise hang forever *after* that,
// because the abort timer was already cleared as soon as fetch() itself
// resolved, leaving res.json()/res.text() completely unprotected. (Verified
// this directly: a server that sends headers immediately but never
// completes the body left res.json() still pending 5+ seconds past a
// 1000ms timeout.) Returns a Response-like object ({ok, status, text(),
// json()}) so existing call sites don't need to change.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: () => text, json: () => JSON.parse(text) };
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
    // Confirmed against real leads on 2026-09-03 (pulled the raw API
    // response directly, not assumed): CheckCherry's attributes object
    // always carries these five keys, null when unset. utm_term came back
    // null on every real lead seen so far, but the key is genuinely part
    // of the schema, so it's captured the same as the others rather than
    // left out on the assumption it doesn't exist.
    utmSource: attrs.utm_source || '',
    utmMedium: attrs.utm_medium || '',
    utmCampaign: attrs.utm_campaign || '',
    utmContent: attrs.utm_content || '',
    utmTerm: attrs.utm_term || '',
  };
}

async function syncCheckCherry() {
  console.log('syncCheckCherry: starting');
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
    console.log(`syncCheckCherry: done (${total} leads)`);
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
  console.log(`GHL chat-lead ${contactId}: calling conversations/search`);
  const searchRes = await fetchWithTimeout(searchUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: 'v3' },
  });
  console.log(`GHL chat-lead ${contactId}: conversations/search returned ${searchRes.status}`);
  if (!searchRes.ok) throw new Error(`GHL conversations/search HTTP ${searchRes.status}: ${searchRes.text().slice(0, 300)}`);
  const searchBody = await searchRes.json();
  const conversations = searchBody.conversations || searchBody.data || [];
  const conversationId = conversations[0] && conversations[0].id;
  if (!conversationId) throw new Error('no conversation found for contact');

  const messagesUrl = `https://services.leadconnectorhq.com/conversations/${conversationId}/messages`;
  console.log(`GHL chat-lead ${contactId}: calling conversations/${conversationId}/messages`);
  const messagesRes = await fetchWithTimeout(messagesUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15' },
  });
  console.log(`GHL chat-lead ${contactId}: messages returned ${messagesRes.status}`);
  if (!messagesRes.ok) throw new Error(`GHL messages HTTP ${messagesRes.status}: ${messagesRes.text().slice(0, 300)}`);
  const messagesBody = await messagesRes.json();
  const raw = messagesBody.messages;
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.messages) ? raw.messages : []);
}

async function summarizeChatTranscript(transcript, contactId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!transcript) throw new Error('empty transcript');

  console.log(`GHL chat-lead ${contactId}: calling Anthropic`);
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
  console.log(`GHL chat-lead ${contactId}: Anthropic returned ${res.status}`);
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${res.text().slice(0, 300)}`);
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
  return summarizeChatTranscript(transcript, contactId);
}

// Only chat-lead contacts created on or after this date are pulled from
// GHL. This replaced pulling and importing GHL's entire contact list
// (~15,844 contacts) on every single sync run, which was the real driver of
// multi-minute sync times — that's no longer the intent at all, not just an
// optimization. Change this (e.g. further back) if a historical backfill is
// ever wanted.
const CHAT_LEAD_SYNC_START = '2026-09-03T00:00:00Z';

// Verified against real data on 2026-09-03 via GET/POST calls directly
// against the live API (not from docs — GHL's request-body field names
// don't match its response field names, and error messages are
// inconsistent enough that this needed hands-on checking):
//   - Endpoint is POST /contacts/search (not GET /contacts/), header
//     Version: v3, body { locationId, pageLimit, filters, searchAfter }.
//   - filters is an array of { field, operator, value }. Tag filtering:
//     { field: 'tags', operator: 'contains', value: 'chat-lead' }.
//   - Date filtering on dateAdded rejects gt/gte/lt/lte/eq/range-as-string
//     (400/422 depending which) — the working form is
//     { field: 'dateAdded', operator: 'range', value: { gte: '<ISO date>' } }.
//   - Response is { contacts: [...], total }. Each contact carries its own
//     searchAfter: [timestamp, id] — pass the last contact's searchAfter
//     back as the top-level searchAfter to get the next page.
//   - Confirmed correct against known data: tags-only filter returned
//     exactly the 2 known chat-lead contacts from earlier testing; a
//     dateAdded>=2026-07-01 + tags filter returned exactly the 6 contacts
//     independently predicted from an unfiltered listing; the real
//     production cutoff (2026-09-03) correctly returned 0 (no chat-leads
//     created yet today); and paginating via searchAfter produced two
//     non-overlapping pages.
async function fetchGhlChatLeadContacts(apiKey, locationId) {
  const contacts = [];
  let searchAfter;
  let page = 1;
  for (;;) {
    const requestBody = {
      locationId,
      pageLimit: 100,
      filters: [
        { field: 'tags', operator: 'contains', value: 'chat-lead' },
        { field: 'dateAdded', operator: 'range', value: { gte: CHAT_LEAD_SYNC_START } },
      ],
    };
    if (searchAfter) requestBody.searchAfter = searchAfter;

    console.log(`syncGHL: fetching chat-lead contacts page ${page}`);
    const res = await fetchWithTimeout('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Version: 'v3', 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) throw new Error(`GHL contacts/search HTTP ${res.status}: ${res.text().slice(0, 300)}`);
    const body = await res.json();
    const pageContacts = body.contacts || [];
    console.log(`syncGHL: page ${page} returned ${pageContacts.length} contacts (total matching: ${body.total})`);
    if (!pageContacts.length) break;
    contacts.push(...pageContacts);
    if (pageContacts.length < 100) break;

    const last = pageContacts[pageContacts.length - 1];
    if (!last.searchAfter) break;
    searchAfter = last.searchAfter;
    page++;
    if (page > 50) break; // safety cap, matching the pattern used elsewhere in this file
  }
  return contacts;
}

async function syncGHL() {
  console.log('syncGHL: starting');
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return recordStatus('GHL', { ok: null, error: 'not configured', count: 0 });
  try {
    const contacts = await fetchGhlChatLeadContacts(apiKey, locationId);
    let total = 0;
    for (const c of contacts) {
      // Defense-in-depth: the server-side filters above are verified
      // correct (see notes on fetchGhlChatLeadContacts), but don't trust a
      // remote API unconditionally — re-check locally before importing.
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      if (!tags.includes('chat-lead')) continue;
      if (!c.dateAdded || Date.parse(c.dateAdded) < Date.parse(CHAT_LEAD_SYNC_START)) continue;

      const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ');
      const email = c.email || '';
      if (!email && !name) continue; // malformed/unmapped record — never write a junk row

      const source = 'Chat Lead';
      const interest = (c.tags || []).join(', ');

      const target = computeTarget({ source, interest });
      const existing = findLead(email, target);
      let notes;
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
    recordStatus('GHL', { ok: true, count: total });
    console.log(`syncGHL: done (${total} contacts)`);
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

// Same normalization flattenUserColumnData() uses for the Google Ads
// webhook (lowercase, non-alphanumeric stripped) — column headers with
// punctuation/casing variance (e.g. "what_services_are_you_interested_in?")
// won't reliably exact-match a hardcoded alias list otherwise.
function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(obj, aliases) {
  const normalized = {};
  Object.keys(obj).forEach((k) => { normalized[normalizeKey(k)] = obj[k]; });
  for (const alias of aliases) {
    const value = normalized[normalizeKey(alias)];
    if (value) return value;
  }
  return '';
}

// Meta's "Send Test Data" placeholder marker, and the id prefix its own
// test rows use — either one means skip, never import.
function isMetaTestRow(rowObj) {
  const id = pick(rowObj, ['id']);
  if (/^test/i.test(id)) return true;
  return Object.values(rowObj).some((v) => String(v).includes('<test lead:'));
}

// Meta appends its own "p:" prefix to phone numbers in this export.
function stripPhonePrefix(v) {
  return String(v || '').replace(/^p:/i, '');
}

// Meta's created_time isn't in a confirmed single format — parse
// defensively and only use it if it actually parses to a real date;
// otherwise let upsertLead() fall back to today rather than storing
// garbage.
function parseDateReceived(v) {
  if (!v) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

// Meta Ads' real export header doesn't match the generic CSV mapping below
// (that mapping was written against a simplified test fixture, not this
// sheet) — no single "name" or "interest" column, phone has a literal "p:"
// prefix, and there's no combined free-text field. lead_status / Synced /
// CheckCherry Lead ID / Synced At / Sync Error belong to a separate,
// human-managed CheckCherry workflow and are ignored here entirely.
// Returns null for a row that should be skipped (a test submission).
function mapMetaAdsRow(rowObj) {
  if (isMetaTestRow(rowObj)) return null;

  const name = pick(rowObj, ['name', 'full name'])
    || [pick(rowObj, ['first_name']), pick(rowObj, ['last_name'])].filter(Boolean).join(' ');
  const email = pick(rowObj, ['email']);
  if (!email && !name) return null; // malformed/unmapped record — never write a junk row

  // Three separate free-text columns each carry real signal — combine all
  // three rather than picking one and losing the other two.
  const interestParts = [
    ['Services', pick(rowObj, ['what_services_are_you_interested_in?'])],
    ['Planning', pick(rowObj, ['what_are_you_planning(e.g.,_gala,_conference,_festival,trade_show,_product_launch)'])],
    ['Goal', pick(rowObj, ['tell_us_about_your_event_goal?'])],
  ].filter(([, v]) => v);
  const interest = interestParts.map(([label, v]) => `${label}: ${v}`).join(' | ');

  return {
    source: 'Meta Ads',
    name,
    company: '',
    email,
    phone: stripPhonePrefix(pick(rowObj, ['phone'])),
    location: '',
    interest,
    status: 'New',
    owner: '',
    notes: '',
    nextFollowUp: 'Yes',
    dateReceived: parseDateReceived(pick(rowObj, ['created_time'])),
  };
}

function mapGenericCsvRow(rowObj, sourceName) {
  const email = pick(rowObj, ['email', 'email address']);
  const name = pick(rowObj, ['name', 'full name', 'full_name']);
  if (!email && !name) return null; // malformed/unmapped record — never write a junk row
  return {
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
  };
}

async function syncCsvSheet(envVar, sourceName) {
  console.log(`syncCsvSheet(${sourceName}): starting`);
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

      const lead = sourceName === 'Meta Ads'
        ? mapMetaAdsRow(rowObj)
        : mapGenericCsvRow(rowObj, sourceName);
      if (!lead) continue;

      upsertLead(lead);
      total++;
    }
    recordStatus(sourceName, { ok: true, count: total });
    console.log(`syncCsvSheet(${sourceName}): done (${total} rows)`);
  } catch (err) {
    recordStatus(sourceName, { ok: false, error: err.message, count: 0 });
  }
}

async function runFullSync() {
  console.log('runFullSync: starting');
  await Promise.allSettled([
    syncCheckCherry(),
    syncGHL(),
    syncCsvSheet('META_ADS_CSV_URL', 'Meta Ads'),
    syncCsvSheet('GOOGLE_ADS_CSV_URL', 'Google Ads'),
  ]);
  return getSyncStatus();
}

module.exports = { runFullSync, getSyncStatus };
