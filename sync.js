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

// Every status mapCheckCherryLead() below can produce entirely on its own,
// driven purely by CheckCherry's own boolean flags — never a human's
// manual triage from /admin. Referenced by syncCheckCherryProposals()'s
// convert_from_lead 'Won' promotion: a row still sitting at any of these
// hasn't been touched by a person yet, so it's safe to promote; anything
// else means someone already took it over, and is left alone.
const SYNC_ONLY_STATUSES = ['New', 'Converted', 'Spam', 'Archived'];

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
    // Real field, verified against live /leads data on 2026-09-10 (same
    // field mapCheckCherryProposalEvent() below already uses for /events).
    // Without this, upsertLead()'s insert path fell back to "today" —
    // whatever day the sync happened to first see the lead — and since
    // date_received is only ever set on insert, never corrected on a
    // later update, that stamped every CheckCherry lead with its sync
    // date instead of its real creation date permanently. See
    // scripts/backfill-checkcherry-dates.js for the one-time correction
    // this needed on rows already inserted before this fix existed.
    dateReceived: attrs.created_at ? attrs.created_at.slice(0, 10) : undefined,
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

// CheckCherry's leads endpoint isn't the only way a prospect enters the
// system: staff can also "Quick Add" a proposal directly onto an event from
// the CheckCherry dashboard (for a phone/email inquiry, a repeat client,
// etc.), which never creates a /leads record at all. Verified directly
// against the real API on 2026-09-10 (key required its own
// "assigned_event_read_pricing"/"unassigned_event_read_pricing" permission
// before GET /events stopped 403'ing) by pulling all 1,060 events and
// cross-checking their emails against every /leads record ever returned:
// of the still-open proposals created since 2026-01-01, the ones with
// created_via "quick_add"/"duplicate"/"mobile_app" had no matching /leads
// row at all, confirming the gap for those.
//
// created_via "convert_from_lead" ones were originally assumed to already
// be covered by syncCheckCherry()'s /leads sync above, since they started
// out as a real lead — but cross-checking CheckCherry's own reporting API
// (GET /api/v1/reporting/lead_count_summary, verified against real data on
// 2026-09-10) revealed that assumption was wrong: /leads only ever returns
// currently-open, unconverted leads — the moment one converts to a
// proposal/event it disappears from that endpoint for good. Confirmed
// directly: all 14 real convert_from_lead events created since 2026-01-01
// (4 of them already 'confirmed' — real won business) had zero matching
// row anywhere in the leads table. So convert_from_lead is now imported
// here too, at every status including 'confirmed' (see
// isRelevantProposalEvent()/initialStatusFor() below) — it's the only
// place these ever show up once the originating lead has converted.
//
// Event objects carry no lead_id/lead relationship — matching is by email
// only (same as upsertLead() already does). customer_names/_emails/_phones
// come back as comma-joined strings (never arrays), even for a single
// customer.
function firstOf(commaJoinedList) {
  return String(commaJoinedList || '').split(',')[0].trim();
}

// The only status values CheckCherry's API has ever returned (checked
// across all 1,060 events, not just recent ones): 'confirmed' (booked)
// plus these three pre-booking stages. canceled/archived/postponed are
// separate boolean flags on the same object, checked independently below.
const OPEN_PROPOSAL_STATUSES = ['proposal_date_open', 'proposal_date_reserved', 'awaiting_signature'];

function isRelevantProposalEvent(attrs) {
  if (attrs.canceled || attrs.archived || attrs.postponed) return false;
  if (attrs.created_via === 'convert_from_lead') {
    // These originated as a real /leads record that has since converted
    // and vanished from that live endpoint entirely — this is the only
    // place left to ever see them, so import at any status, 'confirmed'
    // included (real won business that would otherwise never show up
    // anywhere in this system at all).
    return OPEN_PROPOSAL_STATUSES.includes(attrs.status) || attrs.status === 'confirmed';
  }
  // quick_add/duplicate/mobile_app: unchanged from the original scope —
  // still-open proposals only. A confirmed one of these never had an
  // originating lead record to begin with, so there's no continuity gap
  // to fix by importing it too.
  return OPEN_PROPOSAL_STATUSES.includes(attrs.status);
}

// The status a newly-inserted row from this sync should start at. Real
// won business (a converted lead whose event is already 'confirmed')
// should read as 'Won', not 'Proposal Sent' — everything else keeps the
// existing 'Proposal Sent' treatment.
function initialStatusFor(attrs) {
  return attrs.status === 'confirmed' ? 'Won' : 'Proposal Sent';
}

function mapCheckCherryProposalEvent(record) {
  const attrs = (record && record.attributes) || record || {};
  const venueParts = [attrs.venue_city, attrs.venue_state].filter(Boolean).join(', ');

  return {
    source: 'CheckCherry',
    name: firstOf(attrs.customer_names),
    company: '',
    email: firstOf(attrs.customer_emails),
    phone: firstOf(attrs.customer_phones),
    location: venueParts,
    interest: attrs.package_name || attrs.service_name || attrs.title || '',
    notes: attrs.private_notes || attrs.public_notes || '',
    nextFollowUp: 'Yes',
    // Real value, always the created date (used as dateReceived below), so
    // this is only meaningful as a fallback if that ever comes back blank.
    dateReceived: attrs.created_at ? attrs.created_at.slice(0, 10) : undefined,
    utmSource: attrs.utm_source || '',
    utmMedium: attrs.utm_medium || '',
    utmCampaign: attrs.utm_campaign || '',
    utmContent: attrs.utm_content || '',
    utmTerm: attrs.utm_term || '',
  };
}

async function syncCheckCherryProposals() {
  console.log('syncCheckCherryProposals: starting');
  const apiKey = process.env.CHECKCHERRY_API_KEY;
  if (!apiKey) return recordStatus('CheckCherry Proposals', { ok: null, error: 'not configured', count: 0 });
  try {
    let page = 1;
    let total = 0;
    for (;;) {
      const url = `https://api.checkcherry.com/api/v1/events?page=${page}&per=100`;
      // Each page comes back much heavier than /leads' (measured ~750-900KB
      // for 100 events vs. a few KB per lead — the pricing/proposal/URL
      // fields alone roughly triple the attribute count) — DEFAULT_TIMEOUT_MS
      // was cutting it close on a real run (page 11 timed out at 15s during
      // testing even though every page normally takes 3-6s), so this gets
      // its own more generous timeout rather than raising it globally for
      // every other (much lighter) sync in this file.
      const res = await fetchWithTimeout(url, { headers: { 'Api-Key': apiKey } }, 30000);
      if (!res.ok) throw new Error(`CheckCherry events HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const records = Array.isArray(body) ? body : (body.data || []);
      if (!records.length) break;
      for (const record of records) {
        const attrs = (record && record.attributes) || {};
        if (!isRelevantProposalEvent(attrs)) continue;
        const lead = mapCheckCherryProposalEvent(record);
        // Unlike syncCheckCherry() above (which tolerates a name-only lead),
        // this path requires an email: findLead()/upsertLead() dedupe by
        // email alone, with no fallback key (no event id column on the
        // leads table), so a name-only record would never match its own
        // previously-inserted row — every 15-minute cycle would insert a
        // fresh duplicate for the same event forever instead of updating
        // one. No real event has come back email-less yet, but skip
        // defensively rather than let that silently happen the first time
        // one does.
        if (!lead.email) continue;

        // Stamp the initial status only the first time this contact is
        // seen — once it's a row in the leads table, staff manage its
        // status from /admin like any other lead. Re-passing a status on
        // every sync cycle (this runs every 15 min) would silently stomp
        // a manual status change (e.g. to "Contacted") right back to
        // whatever this sync would otherwise set it to.
        //
        // One deliberate exception: a convert_from_lead event reaching
        // 'confirmed' whose row already exists here gets promoted to
        // 'Won' — but only if its current status is one mapCheckCherryLead()
        // could have set entirely on its own (see SYNC_ONLY_STATUSES),
        // never a status a human actually chose. Without this, a lead
        // captured while e.g. converted_to_event was already true (so
        // mapCheckCherryLead() stamped it 'Converted', not 'New') would
        // fail the original New-only check and stay stuck at 'Converted'
        // forever even once really confirmed/won — silently defeating the
        // whole point of this promotion for exactly the rows it's
        // supposed to help.
        const target = computeTarget(lead);
        const existing = findLead(lead.email, target);
        let status = '';
        if (!existing) {
          status = initialStatusFor(attrs);
        } else if (attrs.status === 'confirmed' && SYNC_ONLY_STATUSES.includes(existing.status)) {
          status = 'Won';
        }
        upsertLead({ ...lead, status });
        total++;
      }
      if (records.length < 100) break;
      page++;
      if (page > 50) break;
    }
    recordStatus('CheckCherry Proposals', { ok: true, count: total });
    console.log(`syncCheckCherryProposals: done (${total} proposals)`);
  } catch (err) {
    recordStatus('CheckCherry Proposals', { ok: false, error: err.message, count: 0 });
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

const WIX_SITE_ID = '54f29a7c-7e6b-4f9a-97b2-bb6964356278';
const WIX_NAMESPACE = 'wix.form_app.form';

// A form's set of fields — and which formId even exists — isn't stable
// enough to hardcode: confirmed directly against the real site on
// 2026-09-15 that it has 10 distinct forms (GET .../form-schema-service/
// v4/forms/query), each with its own field schema, and that even the one
// form already synced had a "Phone" field added to it since it was first
// wired up. So instead of a fixed formId + field-key list, every sync
// cycle re-discovers every form on the site and maps each one generically
// by field label (see mapWixFormSubmission() below) — nothing here is
// specific to any one form.
//
// A form's real Wix name is used for its source label. One exception:
// this form already had 174+ rows synced under a deliberately-chosen
// label from before form discovery existed — kept here so switching to
// automatic discovery doesn't silently split already-synced rows under a
// second, different-looking source.
const KNOWN_WIX_FORM_LABELS = {
  '71826e5f-736b-4792-b486-4f64ca8d331b': 'Wix Form - Digital Mirror Homepage',
};

// Wix's own un-customized default name ("My Form", "My Form 1", "My Form
// 2", ...) isn't a real, human-chosen name — treated the same as no name
// at all. Confirmed against the real site: 3 of the 10 forms still carry
// this exact default. Falls back to an identifiable label (a short,
// traceable fragment of the real formId) rather than presenting a raw
// UUID, or the meaningless placeholder, as if either were a real name.
function wixFormSourceLabel(form) {
  const known = KNOWN_WIX_FORM_LABELS[form.id];
  if (known) return known;
  const name = (form.name || '').trim();
  if (name && !/^my form\s*\d*$/i.test(name)) return `Wix Form - ${name}`;
  return `Wix Form - Untitled (${form.id.slice(0, 8)})`;
}

// Every field a form has ever had, current and since-deleted/replaced —
// GetForm's response retains removed/renamed field definitions under
// deletedFields, confirmed against real data: form 3c982836's *current*
// schema no longer has several fields (venue_name, describe_your_experience,
// date_and_time, event_date_and_time, ...) that its own older real
// submissions still carry values under — every one of them shows up here.
// Without this, an old submission using a target key the current schema
// doesn't have anymore would silently lose that value with no error at
// all — worst case, if the dropped field happened to be the email field
// itself, the whole submission (not just one field of it) would vanish
// silently, since email is required before insert.
function allFieldDefinitions(form) {
  return [...(form.fields || []), ...(form.deletedFields || [])];
}

// Every field's storage "target" (e.g. "email_ad54") is an auto-generated
// per-form disambiguation suffix, not a stable identity across forms —
// two different forms' "Email" fields have completely different target
// keys. A field's label is the most reliable way to know what a *custom*
// field actually is (see classifyFieldLabel() below) — but Wix also tags
// its own built-in contact fields with a semantic fieldType
// (CONTACTS_EMAIL/_FIRST_NAME/_LAST_NAME/_PHONE), captured here too since
// it's needed to fix a real mismatch label-matching alone gets wrong (see
// classifyFieldLabel()'s comment). Built once per form (current fields win
// over a deleted one on the rare chance the same target were ever reused).
function buildFieldMetaMap(form) {
  const map = {};
  allFieldDefinitions(form).forEach((f) => {
    if (f.target && f.view && f.view.label && !map[f.target]) {
      map[f.target] = { label: f.view.label, fieldType: f.view.fieldType };
    }
  });
  return map;
}

const CONTACT_FIELD_TYPES = {
  CONTACTS_FIRST_NAME: 'firstName',
  CONTACTS_LAST_NAME: 'lastName',
  CONTACTS_EMAIL: 'email',
  CONTACTS_PHONE: 'phone',
};

// Which of the 4 categories this form has (or ever had) a genuinely
// Wix-tagged field for (fieldType CONTACTS_EMAIL etc. — the same semantic
// tag Wix uses to sync a field into the site's real Contacts list).
// Computed once per form so classifyField() below can tell "no field in
// this form is tagged as the real email field, so trust the label match"
// apart from "this form already has a real tagged email field, so a
// label merely containing the word doesn't get to also claim that
// category."
function taggedCategoriesInForm(form) {
  const present = {};
  allFieldDefinitions(form).forEach((f) => {
    const category = CONTACT_FIELD_TYPES[f.view && f.view.fieldType];
    if (category) present[category] = true;
  });
  return present;
}

// Case-insensitive, as specified: "first" and "name" together is a
// first-name field, "last" and "name" a last-name field, anything
// mentioning "email" or "phone" is that. Everything else (budget, event
// type, venue, how they heard about us, whatever a given form happens to
// ask) is combined into notes/interest instead of being silently dropped.
//
// fieldType is checked first, and — critically — a category already
// satisfied by a genuinely-tagged field (tagged) disables the label
// fallback for that category on every OTHER field in the same form.
// Confirmed against real data that without this, label-substring matching
// alone gets it wrong on a field literally labeled "Can we send you
// information and promotion emails?" (a Yes/No opt-in question, Wix
// fieldType RADIO_GROUP, not CONTACTS_EMAIL) — its label contains
// "email", so on its own it's misclassified as the actual email field.
// This really happened on a real Julian Hill/GSK Canada submission during
// testing: his true email was silently discarded because that consent
// question's "No thanks" value won the match instead — checking fieldType
// on that one field alone wasn't enough to stop it, since the label match
// still independently caught it as a second, competing "email" field.
// Label matching for a category still applies normally in a form that has
// no genuinely-tagged field for it at all.
function classifyField(fieldMeta, tagged) {
  const byType = CONTACT_FIELD_TYPES[fieldMeta.fieldType];
  if (byType) return byType;

  const normalized = (fieldMeta.label || '').toLowerCase();
  if (!tagged.firstName && normalized.includes('first') && normalized.includes('name')) return 'firstName';
  if (!tagged.lastName && normalized.includes('last') && normalized.includes('name')) return 'lastName';
  if (!tagged.email && normalized.includes('email')) return 'email';
  if (!tagged.phone && normalized.includes('phone')) return 'phone';
  return 'other';
}

// Wix's Form Submission Service wraps each entry's actual field values
// under a nested `submissions` map, keyed by target, not label. Maps
// generically by field metadata (via classifyField()) rather than a
// per-form hardcoded key list, since field keys and even which fields
// exist differ across every form on this site — confirmed directly
// against real data on 2026-09-15 (10 forms, no two sharing a schema,
// some 21-submission-old forms whose own schema has visibly evolved over
// their history: earlier submissions on the same formId carry fields the
// current schema doesn't even have anymore). Two real submissions
// verified end-to-end this way: Margaret Kuettel's Diwali sampling
// program inquiry (the original homepage form) and, on the newly-
// discovered form, Emma Mansell's CIBC inquiry and Julian Hill's GSK
// Canada inquiry.
//
// fieldMetaByTarget/tagged/sourceLabel are computed once per form by the
// caller (syncWixFormSubmissions()) and passed in rather than rebuilt
// here — this runs once per submission, up to 100 per page, so rebuilding
// them from the form's schema on every single record would be wasted work
// that scales with total submission count instead of form count.
function mapWixFormSubmission(record, fieldMetaByTarget, tagged, sourceLabel) {
  const values = record.submissions || {};

  let firstName = '';
  let lastName = '';
  let email = '';
  let phone = '';
  const otherParts = [];

  Object.keys(values).forEach((target) => {
    const value = values[target];
    if (value === null || value === undefined || value === '') return;
    const fieldMeta = fieldMetaByTarget[target];
    if (!fieldMeta) return; // no real label to identify this field by — never guess what it is
    switch (classifyField(fieldMeta, tagged)) {
      case 'firstName': firstName = firstName || String(value); break;
      case 'lastName': lastName = lastName || String(value); break;
      case 'email': email = email || String(value); break;
      case 'phone': phone = phone || String(value); break;
      default: otherParts.push(`${fieldMeta.label}: ${value}`);
    }
  });

  // Requires an email, unlike the name-only tolerance elsewhere in this
  // file: this sync re-queries the same full submission history every 15
  // minutes with no date filter, and findLead()/upsertLead() dedupe by
  // email alone with no fallback key — a name-only submission would never
  // match its own previously-inserted row, so it'd get re-inserted as a
  // fresh duplicate every single cycle forever instead of updating one
  // (the exact failure mode already fixed this way in
  // syncCheckCherryProposals() above).
  if (!email) return null;

  return {
    source: sourceLabel,
    name: [firstName, lastName].filter(Boolean).join(' '),
    company: '',
    email,
    phone,
    location: '',
    interest: otherParts.join(' | '),
    status: 'New',
    owner: '',
    notes: '',
    nextFollowUp: 'Yes',
    // Real field, verified against live data. Same "always use the real
    // date, never fall back to today" fix already applied to CheckCherry's
    // mapCheckCherryLead() — upsertLead()'s insert path defaults to
    // today's date whenever this comes back undefined, which would
    // otherwise stamp every Wix lead with its sync date instead of when
    // it was actually submitted.
    dateReceived: record.createdDate ? record.createdDate.slice(0, 10) : undefined,
  };
}

// Discovers every form on the site rather than syncing a hardcoded list.
// Confirmed directly against the real API on 2026-09-15: the response
// shape is { forms: [...], metadata: { count, cursors, hasNext } } — the
// same paging convention QuerySubmissionsByNamespace already uses, not
// the different-looking example shown in Wix's own published docs (which
// don't match a real call here, same kind of doc/reality mismatch already
// hit elsewhere in this project — verified against the live response, not
// assumed from the docs).
async function fetchAllWixForms(apiKey) {
  const forms = [];
  let cursor;
  let page = 1;
  for (;;) {
    const query = cursor ? { cursorPaging: { limit: 100, cursor } } : { cursorPaging: { limit: 100 } };
    const res = await fetchWithTimeout('https://www.wixapis.com/form-schema-service/v4/forms/query', {
      method: 'POST',
      headers: { Authorization: apiKey, 'wix-site-id': WIX_SITE_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: WIX_NAMESPACE, query }),
    });
    if (!res.ok) throw new Error(`Wix Query Forms HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    forms.push(...(body.forms || []));
    const meta = body.metadata || {};
    if (!meta.hasNext || !meta.cursors || !meta.cursors.next) break;
    cursor = meta.cursors.next;
    page++;
    if (page > 50) break; // safety cap, matching the pattern used elsewhere in this file
  }
  return forms;
}

async function syncWixFormSubmissions(apiKey, form) {
  // Computed once per form, not per submission — see mapWixFormSubmission()'s comment.
  const fieldMetaByTarget = buildFieldMetaMap(form);
  const tagged = taggedCategoriesInForm(form);
  const sourceLabel = wixFormSourceLabel(form);

  let cursor;
  let total = 0;
  let page = 1;
  for (;;) {
    // Verified directly against the real API: the body must be wrapped in
    // a top-level "query" object — a flat {filter, sort, cursorPaging}
    // body 400s with "query must not be empty". Per Wix's own docs,
    // filter/sort are only meaningful on the first request; a paginated
    // request carries only cursorPaging.cursor (no filter/sort), since
    // the cursor already encodes the original query.
    const query = cursor
      ? { cursorPaging: { limit: 100, cursor } }
      : {
        filter: { formId: form.id, namespace: WIX_NAMESPACE },
        sort: [{ fieldName: 'createdDate', order: 'DESC' }],
        cursorPaging: { limit: 100 },
      };
    const res = await fetchWithTimeout('https://www.wixapis.com/form-submission-service/v4/submissions/namespace/query', {
      method: 'POST',
      headers: {
        // API-key auth, not OAuth — the raw key value, no "Bearer " prefix.
        Authorization: apiKey,
        'wix-site-id': WIX_SITE_ID,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Wix Forms HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const submissions = body.submissions || [];
    for (const record of submissions) {
      const lead = mapWixFormSubmission(record, fieldMetaByTarget, tagged, sourceLabel);
      if (!lead) continue;
      upsertLead(lead);
      total++;
    }
    const meta = body.metadata || {};
    if (!meta.hasNext || !meta.cursors || !meta.cursors.next) break;
    cursor = meta.cursors.next;
    page++;
    if (page > 50) break; // safety cap, matching the pattern used elsewhere in this file
  }
  return total;
}

async function syncWixForms() {
  console.log('syncWixForms: starting');
  const apiKey = process.env.WIX_API_KEY;
  if (!apiKey) return recordStatus('Wix Forms', { ok: null, error: 'not configured', count: 0 });
  try {
    const forms = await fetchAllWixForms(apiKey);
    let total = 0;
    for (const form of forms) {
      const count = await syncWixFormSubmissions(apiKey, form);
      total += count;
      console.log(`syncWixForms: "${form.name}" (${form.id}) -> ${count} lead(s)`);
    }
    recordStatus('Wix Forms', { ok: true, count: total, forms: forms.length });
    console.log(`syncWixForms: done (${forms.length} forms, ${total} leads)`);
  } catch (err) {
    recordStatus('Wix Forms', { ok: false, error: err.message, count: 0 });
  }
}

async function runFullSync() {
  console.log('runFullSync: starting');
  await Promise.allSettled([
    syncCheckCherry(),
    syncCheckCherryProposals(),
    syncGHL(),
    syncCsvSheet('META_ADS_CSV_URL', 'Meta Ads'),
    syncCsvSheet('GOOGLE_ADS_CSV_URL', 'Google Ads'),
    syncWixForms(),
  ]);
  return getSyncStatus();
}

module.exports = { runFullSync, getSyncStatus };
