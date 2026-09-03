// Pulls leads in from external sources on a schedule: CheckCherry API,
// GHL API, and Google Sheets published-to-web CSVs (Meta Ads / Google Ads).
// Each source is independent and best-effort.

const { upsertLead } = require('./db');

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
        upsertLead({
          source: 'GHL',
          name,
          company: c.companyName || '',
          email,
          phone: c.phone || '',
          location: c.city || '',
          interest: (c.tags || []).join(', '),
          status: 'New',
          owner: '',
          notes: '',
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
