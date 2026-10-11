// Google Ads offline conversions: uploads a click conversion ("CheckCherry Lead Created
// Ads") for a newly-created CheckCherry lead that carries a gclid / gbraid / wbraid.
//
// Env: GOOGLE_ADS_CONVERSION_ACTION_ID (the "Import from clicks" conversion action id),
// GOOGLE_ADS_UPLOAD_DRY_RUN=true (log what would be uploaded, send nothing, record nothing),
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (OAuth, must be
// authorised for the https://www.googleapis.com/auth/adwords scope) and
// GOOGLE_ADS_DEVELOPER_TOKEN (required by the Google Ads API itself). Optional:
// GOOGLE_ADS_LOGIN_CUSTOMER_ID (manager account id, if the customer is accessed through
// one), GOOGLE_ADS_API_VERSION (default below), GOOGLE_ADS_UPLOAD_DISABLED=true (kill switch).
//
// Rules: only a lead the sync just INSERTED is uploaded (so the back catalog is never
// sent), plus earlier transient failures are retried (max MAX_ATTEMPTS). Each submission
// id and each click id is uploaded at most once. Every outcome is logged and recorded in
// ads_conversions. Never throws.

const { GOOGLE_ADS_CONVERSION } = require('./config');
const { getAdsConversion, hasAdsConversionForClick, recordAdsConversion } = require('./db');
const { testLeadReason } = require('./config');

const API_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || 'v23';
const MAX_ATTEMPTS = 5;
const CLICK_WINDOW_DAYS = 90; // Google rejects conversions for clicks older than this

async function postJson(url, headers, body, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    throw new Error(`${label}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const res = await postJson('https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(), 'oauth token');
  if (!res.ok || !res.json || !res.json.access_token) {
    const e = new Error(`oauth token HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    // invalid_grant / invalid_client are config problems: retry after they're fixed.
    e.transient = true;
    throw e;
  }
  return res.json.access_token;
}

// "2026-10-11T14:03:09.000-04:00" -> "2026-10-11 18:03:09+00:00" (UTC).
function formatConversionTime(iso) {
  let d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime()) || d.getTime() > Date.now()) d = new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ') + '+00:00';
}

// The click id to send: Google accepts exactly one of gclid / gbraid / wbraid.
function pickClickId(lead) {
  for (const type of ['gclid', 'gbraid', 'wbraid']) {
    const v = String(lead[type] || '').trim();
    if (v) return { type, id: v };
  }
  return null;
}

function buildConversion(lead, click, sid) {
  const { customerId, conversionActionId } = GOOGLE_ADS_CONVERSION;
  return {
    [click.type]: click.id,
    conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
    conversionDateTime: formatConversionTime(lead.createdAtIso),
    orderId: sid, // Google dedupes uploads on (conversion action, order id)
  };
}

async function sendConversion(conversion) {
  const { customerId } = GOOGLE_ADS_CONVERSION;
  const accessToken = await getAccessToken();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  const res = await postJson(
    `https://googleads.googleapis.com/${API_VERSION()}/customers/${customerId}:uploadClickConversions`,
    headers, JSON.stringify({ conversions: [conversion], partialFailure: true }), 'uploadClickConversions');
  return res;
}

// Pure outcome classification of an uploadClickConversions response.
// -> { status: 'uploaded' | 'rejected' | 'error', detail }
function classifyResponse(res) {
  if (res.ok) {
    const pf = res.json && res.json.partialFailureError;
    if (pf) return { status: 'rejected', detail: `partial failure: ${String(pf.message || JSON.stringify(pf)).slice(0, 400)}` };
    const results = (res.json && res.json.results) || [];
    return { status: 'uploaded', detail: results.length ? JSON.stringify(results[0]).slice(0, 300) : 'accepted' };
  }
  const msg = `HTTP ${res.status}: ${res.text.slice(0, 400)}`;
  // Auth, rate limit and server errors can succeed later; other 4xx (bad id, bad request) can't.
  return { status: (res.status === 401 || res.status === 429 || res.status >= 500) ? 'error' : 'rejected', detail: msg };
}

async function uploadLeadConversion(lead, upsertResult) {
  try {
    const click = pickClickId(lead);
    if (!click || !lead.submissionId) return;
    const sid = lead.submissionId;
    if (process.env.GOOGLE_ADS_UPLOAD_DISABLED === 'true') return;

    const prior = getAdsConversion(sid);
    if (prior && prior.status !== 'error') return; // already uploaded / permanently rejected
    if (prior && prior.attempts >= MAX_ATTEMPTS) return;
    // Brand-new leads only; a lead already stored is only retried if its earlier attempt errored.
    if (!prior && !(upsertResult && upsertResult.action === 'inserted')) return;

    const log = (outcome, detail) => console.log(`[google-ads] ${outcome} sid=${sid} ${click.type}=${click.id.slice(0, 12)}… ${detail || ''}`.trim());

    const skip = testLeadReason(lead);
    if (skip) return log('skipped (test lead)', skip);
    if (hasAdsConversionForClick(click.id, sid)) {
      recordAdsConversion({ sid, clickId: click.id, clickType: click.type, status: 'rejected', detail: 'duplicate click id (already uploaded for another lead)' });
      return log('skipped (duplicate)', 'click id already uploaded for another lead');
    }
    const ageDays = lead.createdAtIso ? (Date.now() - new Date(lead.createdAtIso).getTime()) / 86400000 : 0;
    if (ageDays > CLICK_WINDOW_DAYS) {
      recordAdsConversion({ sid, clickId: click.id, clickType: click.type, status: 'rejected', detail: `older than ${CLICK_WINDOW_DAYS} days` });
      return log('skipped (too old)', `${Math.floor(ageDays)} days`);
    }

    const actionId = GOOGLE_ADS_CONVERSION.conversionActionId;
    if (process.env.GOOGLE_ADS_UPLOAD_DRY_RUN === 'true') {
      // Nothing is sent or recorded, so going live later still uploads this lead's retries/new leads normally.
      const conv = actionId ? buildConversion(lead, click, sid) : { note: 'GOOGLE_ADS_CONVERSION_ACTION_ID not set' };
      return log('DRY RUN would upload', `customer=${GOOGLE_ADS_CONVERSION.customerId} ${JSON.stringify(conv)}`);
    }

    const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CONVERSION_ACTION_ID'].filter((k) => !process.env[k]);
    if (missing.length) {
      recordAdsConversion({ sid, clickId: click.id, clickType: click.type, status: 'error', detail: `not configured: ${missing.join(', ')}` });
      return log('error', `not configured, missing ${missing.join(', ')} (will retry)`);
    }

    let outcome;
    try {
      outcome = classifyResponse(await sendConversion(buildConversion(lead, click, sid)));
    } catch (err) {
      outcome = { status: 'error', detail: err.message };
    }
    recordAdsConversion({ sid, clickId: click.id, clickType: click.type, status: outcome.status, detail: outcome.detail });
    log(outcome.status, outcome.detail);
  } catch (err) {
    console.error(`[google-ads] unexpected error: ${err.message}`);
  }
}

module.exports = { uploadLeadConversion, classifyResponse, buildConversion, formatConversionTime, pickClickId };
