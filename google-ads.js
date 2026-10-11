// Google Ads offline conversions via a Google Sheet: when the CheckCherry sync inserts a NEW
// lead, one row is appended to the first tab of the sheet in GOOGLE_ADS_CONVERSION_SHEET_ID, which
// Google Ads imports on a schedule (Conversions > Uploads > Google Sheets). Columns, in order:
//   A Google Click ID (gclid, blank if none)      B Conversion Time (America/Toronto, DST aware,
//   yyyy-MM-dd HH:mm:ss±HH:MM)                    C Conversion Value (blank)    D Currency (CAD)
//   E Order ID (the CheckCherry lead id)          F SHA-256 of email (trimmed, lowercased)
//   G SHA-256 of phone as E.164
// A row is appended only if it has a gclid, an email or a phone, and its Order ID is not already
// in column E. The sheet's header row (if any) is left as the owner made it.
//
// Env: GOOGLE_ADS_CONVERSION_SHEET_ID, and the OAuth trio GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_REFRESH_TOKEN (the refresh token must carry the spreadsheets scope, and its account needs
// Editor access to the sheet). GOOGLE_ADS_UPLOAD_DRY_RUN=true logs the row (hashes, no raw PII) and
// appends nothing; GOOGLE_ADS_UPLOAD_DISABLED=true is a kill switch.
//
// Only a lead the sync just INSERTED is appended (the back catalog is never sent); an earlier
// transient failure is retried on a later sync (max MAX_ATTEMPTS). Every outcome is logged and
// recorded in ads_conversions. Never throws.

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { getAdsConversion, recordAdsConversion } = require('./db');
const { testLeadReason } = require('./config');

const MAX_ATTEMPTS = 5;
const CLICK_WINDOW_DAYS = 90; // Google rejects conversions for clicks older than this
const TIMEZONE = 'America/Toronto';
const CURRENCY = 'CAD';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// SHA-256 hex of the email, trimmed and lowercased; '' when there is none.
function hashEmail(email) {
  const e = String(email == null ? '' : email).trim().toLowerCase();
  return e ? sha256(e) : '';
}

// SHA-256 hex of the phone normalized to E.164 (+14165551234); '' when absent or not a valid number.
// A number with no country code is read as Canadian.
function hashPhone(phone) {
  const text = String(phone == null ? '' : phone).trim();
  if (!text) return '';
  const parsed = parsePhoneNumberFromString(text, 'CA');
  return parsed && parsed.isValid() ? sha256(parsed.format('E.164')) : '';
}

// ISO timestamp -> "2026-10-11 19:20:00-04:00" in America/Toronto (EST -05:00 / EDT -04:00 as of
// that instant). Unparseable or future times fall back to now (a conversion can't be in the future).
function formatConversionTime(iso, now = new Date()) {
  let d = iso ? new Date(iso) : now;
  if (isNaN(d.getTime()) || d.getTime() > now.getTime()) d = now;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const off = (parts.timeZoneName.match(/GMT([+-]\d{2}:\d{2})/) || [])[1] || '+00:00'; // "GMT-04:00"
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

// "checkcherry:34874197" -> "34874197" (the CheckCherry lead id).
const orderIdOf = (lead) => String(lead.submissionId || '').replace(/^checkcherry:/, '');

// -> the 7 cells A..G, or null when the lead has no gclid, email or phone.
function buildRow(lead) {
  const gclid = String(lead.gclid || '').trim();
  const email = hashEmail(lead.email);
  const phone = hashPhone(lead.phone);
  if (!gclid && !email && !phone) return null;
  return [gclid, formatConversionTime(lead.createdAtIso), '', CURRENCY, orderIdOf(lead), email, phone];
}

// --- Google auth + Sheets ------------------------------------------------------------------

async function request(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    throw new Error(`${label}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  }, 'oauth token');
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error(`oauth token HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
  return res.json.access_token;
}

const authJson = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const sheetUrl = (id) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
const a1 = (title) => `'${String(title).replace(/'/g, "''")}'`;

// Title of the sheet's first tab.
async function firstTabTitle(token, sheetId) {
  const res = await request(`${sheetUrl(sheetId)}?fields=sheets.properties.title`, { headers: authJson(token) }, 'sheets metadata');
  const title = res.ok && res.json && res.json.sheets && res.json.sheets[0] && res.json.sheets[0].properties.title;
  if (!title) throw httpError('sheets metadata', res);
  return title;
}

// Order IDs already in column E.
async function existingOrderIds(token, sheetId, tab) {
  const res = await request(`${sheetUrl(sheetId)}/values/${encodeURIComponent(`${a1(tab)}!E:E`)}`, { headers: authJson(token) }, 'sheets read');
  if (!res.ok) throw httpError('sheets read', res);
  return new Set(((res.json && res.json.values) || []).map((r) => String(r[0] == null ? '' : r[0]).trim()).filter(Boolean));
}

async function appendRow(token, sheetId, tab, row) {
  const res = await request(
    `${sheetUrl(sheetId)}/values/${encodeURIComponent(`${a1(tab)}!A:G`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: authJson(token), body: JSON.stringify({ values: [row] }) }, 'sheets append');
  if (!res.ok) throw httpError('sheets append', res);
  return res.json;
}

function httpError(label, res) {
  const e = new Error(`${label} HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  // auth, rate limit and server errors can succeed later; other 4xx (no access, wrong sheet id) need a config fix
  e.transient = res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429 || res.status >= 500;
  return e;
}

// Which Google account the Sheets refresh token belongs to (share the sheet with it as Editor).
// Logged at startup; never throws.
async function logSheetsAccount() {
  try {
    if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return console.log('[google-ads] Sheets token not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
    }
    const token = await getAccessToken();
    const info = await request(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {}, 'tokeninfo');
    let email = info.json && info.json.email;
    if (!email) {
      const about = await request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: authJson(token) }, 'drive about');
      email = about.ok && about.json && about.json.user && about.json.user.emailAddress;
    }
    const scopes = (info.json && info.json.scope) || '';
    console.log(`[google-ads] Sheets token account: ${email || 'unknown (token has no email/drive scope)'}; sheets scope: ${/auth\/spreadsheets(\s|$)/.test(scopes) ? 'yes' : 'NO'}; sheet ${process.env.GOOGLE_ADS_CONVERSION_SHEET_ID ? 'configured' : 'NOT configured (GOOGLE_ADS_CONVERSION_SHEET_ID)'}; mode: ${process.env.GOOGLE_ADS_UPLOAD_DRY_RUN === 'true' ? 'DRY RUN' : 'live'}`);
  } catch (err) {
    console.log(`[google-ads] Sheets token check failed: ${err.message}`);
  }
}

// --- The hook called by the CheckCherry sync ---------------------------------------------------

async function uploadLeadConversion(lead, upsertResult) {
  try {
    const sid = lead.submissionId;
    if (!sid || process.env.GOOGLE_ADS_UPLOAD_DISABLED === 'true') return;

    const prior = getAdsConversion(sid);
    if (prior && prior.status !== 'error') return; // already appended / permanently skipped
    if (prior && prior.attempts >= MAX_ATTEMPTS) return;
    // Brand-new leads only; a stored lead is retried only if its earlier attempt errored.
    if (!prior && !(upsertResult && upsertResult.action === 'inserted')) return;

    const row = buildRow(lead);
    const orderId = orderIdOf(lead);
    const gclid = row ? row[0] : '';
    const log = (outcome, detail) => console.log(`[google-ads] ${outcome} order=${orderId} ${detail || ''}`.trim());
    const record = (status, detail) => recordAdsConversion({ sid, clickId: gclid, clickType: gclid ? 'gclid' : '', status, detail });

    if (!row) { record('rejected', 'no gclid, email or phone'); return log('skipped', 'no gclid, email or phone'); }
    const skip = testLeadReason(lead);
    if (skip) return log('skipped (test lead)', skip);
    // The owner's own tracking tests (same rule as scripts/backfill-attribution.js).
    if (/^test/i.test(gclid) || String(lead.utmCampaign || '').trim().toLowerCase() === 'test') return log('skipped (test data)', 'gclid starts with TEST or utm_campaign is "test"');
    if (String(lead.status || '').trim().toLowerCase() === 'spam') return log('skipped (spam)');
    const ageDays = lead.createdAtIso ? (Date.now() - new Date(lead.createdAtIso).getTime()) / 86400000 : 0;
    if (gclid && ageDays > CLICK_WINDOW_DAYS) {
      record('rejected', `older than ${CLICK_WINDOW_DAYS} days`);
      return log('skipped (too old)', `${Math.floor(ageDays)} days`);
    }

    if (process.env.GOOGLE_ADS_UPLOAD_DRY_RUN === 'true') {
      // Nothing is read, sent or recorded, so going live later still appends this lead's row.
      return log('DRY RUN would append', `sheet=${process.env.GOOGLE_ADS_CONVERSION_SHEET_ID || '(GOOGLE_ADS_CONVERSION_SHEET_ID not set)'} row=${JSON.stringify(row)}`);
    }

    const sheetId = process.env.GOOGLE_ADS_CONVERSION_SHEET_ID;
    const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ADS_CONVERSION_SHEET_ID'].filter((k) => !process.env[k]);
    if (missing.length) {
      record('error', `not configured: ${missing.join(', ')}`);
      return log('error', `not configured, missing ${missing.join(', ')} (will retry)`);
    }

    try {
      const token = await getAccessToken();
      const tab = await firstTabTitle(token, sheetId);
      if ((await existingOrderIds(token, sheetId, tab)).has(orderId)) {
        record('uploaded', 'order id already in sheet');
        return log('skipped (duplicate)', 'order id already in column E');
      }
      await appendRow(token, sheetId, tab, row);
      record('uploaded', `appended to "${tab}"`);
      log('appended', `tab="${tab}" gclid=${gclid ? 'yes' : 'no'} email=${row[5] ? 'yes' : 'no'} phone=${row[6] ? 'yes' : 'no'}`);
    } catch (err) {
      record('error', err.message);
      log('error', err.message);
    }
  } catch (err) {
    console.error(`[google-ads] unexpected error: ${err.message}`);
  }
}

module.exports = { uploadLeadConversion, logSheetsAccount, buildRow, formatConversionTime, hashEmail, hashPhone };
