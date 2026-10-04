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

module.exports = { CHECKCHERRY_ATTRIBUTES, TEST_LEAD_PATTERNS, INTERNAL_EXCLUDE, testLeadReason };
