// Marketing attribution for CheckCherry records (leads AND events): extraction from the
// record's attributes, the lead_channel rule, and the GHL custom-field entries to write.
// Pure (no database, no network) so the sync, the GHL plan and the backfill share it.
//
// Verified against the live feeds on 2026-10-11: CheckCherry exposes utm_source / utm_medium /
// utm_campaign / utm_term / utm_content and gclid as top-level attributes (no landing-page or
// referrer URL, no gbraid / wbraid / fbclid), plus a free-text `source` and an `origin`
// ("Online Booking" / "Lead Form"). gbraid / wbraid are kept as harmless blanks.

const { CLICK_ID_ATTRIBUTES } = require('./config');

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid'];
const UTM_KEYS = [['utmSource', 'utm_source'], ['utmMedium', 'utm_medium'], ['utmCampaign', 'utm_campaign'], ['utmContent', 'utm_content'], ['utmTerm', 'utm_term']];

const str = (v) => (v == null ? '' : String(v).trim());

// `name=value` token inside a string (a UTM value that smuggles a click id, or a query string).
function tokenFrom(text, key) {
  const m = String(text || '').match(new RegExp(`(?:^|[?&|;,\\s])${key}[=:]([A-Za-z0-9_-]+)`, 'i'));
  return m ? m[1] : '';
}

// Query-string parameters of a URL (or a bare query string) -> plain object (first value wins).
function parseQuery(url) {
  const out = {};
  const q = String(url || '').split('#')[0];
  const query = q.includes('?') ? q.slice(q.indexOf('?') + 1) : q;
  query.split('&').forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    if (k && !(k in out)) out[k] = v;
  });
  return out;
}

// Attribution fields of one CheckCherry record's attributes (lead or event). A spam record
// carries NO click ids (nothing from it may be uploaded or written to GHL).
function extractAttribution(attrs) {
  const a = attrs || {};
  const out = { gclid: '', gbraid: '', wbraid: '' };
  UTM_KEYS.forEach(([k, attr]) => { out[k] = str(a[attr]); });
  out.ccSource = str(a.source);
  out.origin = str(a.origin);
  const utms = UTM_KEYS.map(([, attr]) => str(a[attr]));
  CLICK_IDS.forEach((key) => {
    const attr = CLICK_ID_ATTRIBUTES[key];
    let v = attr ? str(a[attr]) : '';
    if (!v) for (const u of utms) { v = tokenFrom(u, key); if (v) break; }
    out[key] = v;
  });
  if (a.spam) CLICK_IDS.forEach((k) => { out[k] = ''; });
  return out;
}

const META_SOURCES = new Set(['facebook', 'instagram', 'meta']);

// lead_channel. A click id is the ONLY proof of a Google Ads click: the website's hero button
// used to hardcode utm_source=google&utm_medium=cpc on every click, so UTMs alone prove nothing.
//   gclid / gbraid / wbraid                      -> "Google Ads"
//   utm_content=hero_cta (no click id)           -> "Website"   (checked BEFORE the unverified rule:
//                                                   the hardcoded hero link is exactly google/cpc/hero_cta)
//   utm_source=google + utm_medium=cpc (no id)   -> "Google (unverified)"
//   utm_source facebook / instagram / meta       -> "Meta Ads"
//   anything else                                -> utm_source, or "Direct / Unknown"
function deriveChannel(a) {
  const x = a || {};
  if (CLICK_IDS.some((k) => str(x[k]))) return 'Google Ads';
  const source = str(x.utmSource);
  const medium = str(x.utmMedium).toLowerCase();
  if (str(x.utmContent).toLowerCase() === 'hero_cta') return 'Website';
  if (source.toLowerCase() === 'google' && medium === 'cpc') return 'Google (unverified)';
  if (META_SOURCES.has(source.toLowerCase())) return 'Meta Ads';
  return source || 'Direct / Unknown';
}

const GOOGLE_ADS_CHANNEL = 'Google Ads';

// Which GHL field (ghl-canonical FIELDS key) each attribution value is written to.
const ATTRIBUTION_FIELDS = [
  ['gclid', 'GCLID'], ['utmSource', 'UTM_SOURCE'], ['utmMedium', 'UTM_MEDIUM'], ['utmCampaign', 'UTM_CAMPAIGN'],
  ['utmTerm', 'UTM_TERM'], ['utmContent', 'UTM_CONTENT'], ['channel', 'LEAD_CHANNEL'], ['origin', 'LEAD_ORIGIN'],
];

// Values to write for a lead: [{ key, fieldKey, value }], blanks omitted. Only for CheckCherry
// leads (other sources have no such data and must not get "Direct / Unknown"), never for spam.
// First touch wins is enforced by the CALLER writing these fill-blank only (resolveFillBlank).
function attributionValues(lead) {
  const l = lead || {};
  if (String(l.attributionSource || l.source || '') !== 'CheckCherry') return [];
  if (String(l.status || '').trim().toLowerCase() === 'spam') return [];
  const values = { ...l, channel: deriveChannel(l) };
  return ATTRIBUTION_FIELDS
    .map(([key, fieldKey]) => ({ key, fieldKey, value: str(values[key]) }))
    .filter((v) => v.value);
}

module.exports = { extractAttribution, deriveChannel, attributionValues, parseQuery, tokenFrom, GOOGLE_ADS_CHANNEL, ATTRIBUTION_FIELDS };
