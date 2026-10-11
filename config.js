// Deployment-level knobs that are data, not logic. Edit here (or via env where
// noted) rather than inside the mappers.

// CheckCherry /leads attribute names for each normalized shape field. EXACT names
// only: if a name is set and a lead lacks it (missing/null/blank), the field is
// left blank and ONE warning line is logged for that lead (once per process) — the
// mapper never falls through to a different attribute. `null` = the live feed has
// no such attribute, so the field stays blank.
//
// Confirmed 2026-10-04 with scripts/inspect-checkcherry-leads.js against the live
// /leads feed (attribute names only; the feed carries 5 open leads, so several of
// these were present but empty in every lead seen — the names are real, the value
// formats are not yet observed):
//   event_date, lead_event_type, estimated_number_guests, estimated_budget exist.
//   NO owner / assigned_to attribute exists (referred_by_user_* is a referral, not
//   an owner, so it is deliberately not used). `event_type_id` is a numeric id, not
//   a name, so it is not used either.
const CHECKCHERRY_ATTRIBUTES = {
  city: 'venue_city',
  eventDate: 'event_date',
  eventType: 'lead_event_type',
  guestCount: 'estimated_number_guests',
  budgetRange: 'estimated_budget',
  owner: null,
};

// Google Ads click ids on a CheckCherry lead. The landing page passes ?gclid= / gbraid= /
// wbraid= into hidden form fields (or a UTM param); this is the exact attribute name to
// read for each. NOT yet confirmed against the live feed — run
// scripts/inspect-checkcherry-leads.js after the first tagged lead arrives and correct
// these. As a fallback the mapper also looks for `gclid=...` inside the utm_* values.
const CLICK_ID_ATTRIBUTES = { gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid' };

// Google Ads offline conversion target. The customer id is fixed (if it is reached through a manager account, set
// GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager's id); the conversion action
// id comes from GOOGLE_ADS_CONVERSION_ACTION_ID (must be an "Import from clicks" action).
const GOOGLE_ADS_CONVERSION = {
  customerId: '1545947716', // verified as the account holding the conversion actions (AW-11435337008)
  get conversionActionId() { return String(process.env.GOOGLE_ADS_CONVERSION_ACTION_ID || '').trim(); },
};

// Leads that must never enter the GHL funnel: obvious test/internal submissions.
// Checked against name, email and company of every source.
//  - TEST_LEAD_PATTERNS: case-insensitive regexes ("TEST DMA" tolerates any
//    separator, e.g. test.dma@, Test_DMA).
//  - INTERNAL_EXCLUDE: exact addresses, or "@domain.com" to exclude a whole domain.
//    Add more at runtime, without a deploy, via GHL_EXCLUDE_EMAILS (comma-separated,
//    same format).
const TEST_LEAD_PATTERNS = [/test[\s._-]*dma/i];
const INTERNAL_EXCLUDE = [];

function excludedEntries(env = process.env) {
  const fromEnv = String(env.GHL_EXCLUDE_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...INTERNAL_EXCLUDE.map((s) => s.toLowerCase()), ...fromEnv];
}

// -> reason string when the lead is a test/internal one, else null.
function testLeadReason(lead, env = process.env) {
  const email = String((lead && lead.email) || '').trim().toLowerCase();
  const hit = excludedEntries(env).find((e) => (e.startsWith('@') ? email.endsWith(e) : email === e));
  if (hit) return `internal address (${hit})`;
  const text = [lead && lead.name, lead && lead.email, lead && lead.company].filter(Boolean).join(' ');
  const re = TEST_LEAD_PATTERNS.find((p) => p.test(text));
  return re ? `test lead (matches ${re})` : null;
}

// Source-form name -> tag. Matched against the form name (Wix: the name after
// "Wix Form - "). Live Wix forms checked 2026-10-05: "Check Availability.  Get a Quote.
// Secure Your Date." is the quote request; NO Wix form has "quiz" in its name, so
// quiz-completed stays inert until the activation quiz's real form/source name is known
// — add it here (a pattern, or extend the rule) when it is.
const FORM_TAG_RULES = [
  { pattern: /\b(quote|proposal)\b/i, tag: 'proposal-requested' },
  { pattern: /\bquiz\b/i, tag: 'quiz-completed' },
];

function formTags(formName) {
  const name = String(formName || '').trim();
  return name ? FORM_TAG_RULES.filter((r) => r.pattern.test(name)).map((r) => r.tag) : [];
}

// BuyAndRentRobots exclusion for the GHL push guard. EXCLUSION ONLY: a match keeps a
// lead out of the DMA Events funnel; nothing here can pull a lead in or re-route a row.
// It is checked IN ADDITION to the keyword list in db.js (BARR_PATTERN), which is
// unchanged. Evidence for the starting values (2026-10-04 audit): all 4 BARR rows come
// from source "BuyAndRentRobots Website"; no Wix form, Meta campaign or Google campaign
// is BARR.
//  - sourcePatterns:   tested against the lead's source.
//  - campaignPatterns: tested against campaign and utm_campaign.
//  - campaignNames:    exact campaign names or IDs (case-insensitive); add real BARR
//                      campaigns here as they are identified. Empty on purpose for now.
const BARR_EXCLUSION = {
  sourcePatterns: [/^BuyAndRentRobots/i],
  campaignPatterns: [/buyandrentrobots/i],
  campaignNames: [],
};

// -> reason string when the config excludes this lead, else null.
function barrExclusionReason(lead) {
  const l = lead || {};
  const source = String(l.source || '');
  const sp = BARR_EXCLUSION.sourcePatterns.find((re) => re.test(source));
  if (sp) return `source matches ${sp}`;
  const campaigns = [l.campaign, l.utmCampaign].map((c) => String(c || '').trim()).filter(Boolean);
  const names = BARR_EXCLUSION.campaignNames.map((n) => String(n).trim().toLowerCase());
  for (const c of campaigns) {
    const cp = BARR_EXCLUSION.campaignPatterns.find((re) => re.test(c));
    if (cp) return `campaign matches ${cp}`;
    if (names.includes(c.toLowerCase())) return `campaign "${c}" is listed as BuyAndRentRobots`;
  }
  return null;
}

module.exports = { FORM_TAG_RULES, formTags, BARR_EXCLUSION, barrExclusionReason, CHECKCHERRY_ATTRIBUTES, CLICK_ID_ATTRIBUTES, GOOGLE_ADS_CONVERSION, TEST_LEAD_PATTERNS, INTERNAL_EXCLUDE, testLeadReason };
