// Deployment-level knobs that are data, not logic. Edit here (or via env where
// noted) rather than inside the mappers.

// CheckCherry /leads attribute names for each normalized shape field. EXACT names
// only: if a name is set and a lead lacks it (missing/null/blank), the field is
// left blank and ONE warning line is logged for that lead — the mapper never
// falls through to a different attribute. `null` = not confirmed against the live
// feed yet, so the field stays blank. Fill the nulls from the output of
// scripts/inspect-checkcherry-leads.js.
const CHECKCHERRY_ATTRIBUTES = {
  city: 'venue_city', // already used by the existing /leads location mapping
  eventDate: null,
  eventType: null,
  guestCount: null,
  budgetRange: null,
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
