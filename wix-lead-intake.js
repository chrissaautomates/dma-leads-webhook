// Wix -> GHL lead intake business logic: validates a Wix form submission,
// maps it onto DMA Events' canonical GHL fields/tags, and decides what to
// write for a brand-new contact vs. an existing one. Pure functions only —
// no network calls here (those live in ghl-client.js) — so this can be
// tested without mocking fetch at all.
//
// Core design decisions, stated once here rather than scattered as inline
// comments:
//
// 1. NEW-LEAD DEFAULTS ONLY APPLY TO A BRAND-NEW CONTACT.
//    DMA Lead Source = "Website Form", DMA Lead Status = "New", and
//    Lead Score = 0 are only ever included in the payload when creating a
//    new contact. Sending them on every update would silently regress a
//    lead sales has already progressed (status "Hot", score 25) back down
//    to "New"/0 on every repeat Wix submission — a real, dangerous
//    regression, not just an "erase a blank value" case, so it's called out
//    separately from the general no-overwrite-with-blank rule below.
//    DMA Last Activity = "Wix Form Submission" is the one exception: it
//    updates on every submission (new or repeat) because it describes the
//    most recent event, not a cumulative/regressable state — a repeat
//    submission genuinely is the most recent activity.
//
// 2. NEVER OVERWRITE A POPULATED FIELD WITH BLANK.
//    Every field below is only included in the output payload when Wix
//    actually supplied a non-empty value for it. Nothing is ever sent as
//    "" or null to intentionally clear a field.
//
// 3. "Website" (as named in the task spec) isn't a real DMA Lead Source
//    option — "Website Form" is used instead (see ghl-canonical.js).
//
// 4. Values that don't match a canonical picklist option (event type,
//    budget range, interest) are never force-fit into the field. They're
//    preserved in the contact note instead, alongside any free-text
//    message, so nothing Wix sent is silently lost — just not written
//    somewhere it would corrupt reporting.
//
// 5. Marketing consent is written ONLY when Wix explicitly supplied a
//    yes/no answer. No value is ever written for "not supplied" (not even
//    "Unknown") — see the module-level MARKETING_CONSENT handling below for
//    why "Unknown" is deliberately never written by this webhook.

const { FIELDS, FIELD_OPTIONS, TAGS, INTEREST_MAP } = require('./ghl-canonical');

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeKey(value) {
  return normalize(value).toLowerCase();
}

// Matches a submitted value against a picklist's real options, tolerant of
// case and surrounding whitespace (real Wix form data is human-typed or
// dropdown-selected — case drift ("corporate" vs "Corporate") is expected,
// exotic formatting is not, so this deliberately stays a simple
// case-insensitive exact match rather than fuzzy matching that could
// silently pick the wrong option).
function matchOption(value, options) {
  const key = normalizeKey(value);
  if (!key) return null;
  return options.find((opt) => opt.toLowerCase() === key) || null;
}

function required(body, ...keys) {
  return keys.some((k) => normalize(body[k]));
}

// Required minimum per the task spec: (name OR firstName) AND (email OR
// phone). Wix may send a combined `name` field or separate first/last —
// both are accepted for the name half of the check.
function validateWixPayload(body) {
  const errors = [];
  if (!required(body, 'name', 'firstName')) {
    errors.push('Missing required field: name or firstName');
  }
  if (!required(body, 'email', 'phone')) {
    errors.push('Missing required field: email or phone');
  }
  return { valid: errors.length === 0, errors };
}

function splitName(body) {
  if (normalize(body.firstName) || normalize(body.lastName)) {
    return { firstName: normalize(body.firstName), lastName: normalize(body.lastName) };
  }
  const full = normalize(body.name);
  if (!full) return { firstName: '', lastName: '' };
  const parts = full.split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// leadType -> canonical tag, case-insensitive, only when it matches one of
// the seven known concepts (docs/ghl-canonical-tags.md LEAD TYPE section) —
// anything else is silently not tagged rather than guessed at.
function leadTypeTag(leadType) {
  const key = normalizeKey(leadType);
  if (!key) return null;
  return TAGS.LEAD_TYPE[key] || null;
}

// interest / secondaryInterest -> { tag, fieldOption } via INTEREST_MAP.
// Returns null for an unrecognized value (never guessed/inferred).
function lookupInterest(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  return INTEREST_MAP[key] || null;
}

// Builds the DMA_Interest MULTIPLE_OPTIONS value and the interest-* tags to
// apply, from `interest` and `secondaryInterest`. Both are looked up
// independently and only included when explicitly recognized — this is
// where "secondary interest" lives, per Phase 1's design (DMA_Interest is
// multi-select specifically so a second value doesn't need its own field).
function resolveInterests(body) {
  const hits = [lookupInterest(body.interest), lookupInterest(body.secondaryInterest)].filter(Boolean);
  const fieldOptions = [...new Set(hits.map((h) => h.fieldOption))];
  const tags = [...new Set(hits.map((h) => h.tag).filter(Boolean))];
  return { fieldOptions, tags };
}

// Free-text note: the original message, plus (only when present) any
// submitted value that didn't cleanly map to a canonical field option —
// preserved here rather than dropped, per design decision #4 above.
function buildNote(body, unmapped) {
  const lines = [];
  if (normalize(body.message)) lines.push(`Message: ${normalize(body.message)}`);
  if (normalize(body.guestCount)) lines.push(`Guest Count (no canonical field for this yet): ${normalize(body.guestCount)}`);
  unmapped.forEach(({ label, value }) => {
    lines.push(`${label} (submitted value did not match a canonical option): ${value}`);
  });
  if (!lines.length) return null;
  return [
    'Submitted via Wix lead form.',
    ...lines,
    `Page: ${normalize(body.pageUrl) || '(not provided)'}`,
  ].join('\n');
}

// Core mapping function. `isNewContact` must be determined by the caller
// (ghl-client.js's findDuplicateContact / createContact result) BEFORE
// calling this — see design decision #1 above for why new-vs-existing
// changes what gets written, not just how it's written.
//
// Returns:
//   { contactFields, customFields, tags, note, warnings }
// where contactFields/customFields are ready to hand to ghl-client.js's
// createContact/updateContact, tags is an array of tag name strings ready
// for addTags(), note is a string or null ready for createNote(), and
// warnings is a list of human-readable strings about anything that
// couldn't be mapped (for logging — never exposed to the Wix caller).
function buildLeadPlan(body, { isNewContact }) {
  const warnings = [];
  const unmapped = [];
  const { firstName, lastName } = splitName(body);

  const contactFields = {};
  if (firstName) contactFields.firstName = firstName;
  if (lastName) contactFields.lastName = lastName;
  if (normalize(body.email)) contactFields.email = normalize(body.email);
  if (normalize(body.phone)) contactFields.phone = normalize(body.phone);
  if (normalize(body.company)) contactFields.companyName = normalize(body.company);
  if (normalize(body.city)) contactFields.city = normalize(body.city);
  // `source` is GHL's native attribution field (distinct from the
  // canonical DMA Lead Source custom field, which carries the same
  // information in the DMA-specific taxonomy) — set on create only, same
  // "don't regress an existing contact's original attribution" reasoning
  // as the DMA Lead Source custom field below.
  if (isNewContact) contactFields.source = 'Wix Lead Form';

  const customFields = [];
  function setField(id, value) {
    if (value === undefined || value === null || value === '') return;
    customFields.push({ id, fieldValue: value });
  }

  // --- New-lead-only defaults (see design decision #1) ---
  if (isNewContact) {
    setField(FIELDS.LEAD_SOURCE, 'Website Form'); // "Website" per spec -> closest real option, see ghl-canonical.js
    setField(FIELDS.LEAD_STATUS, 'New');
    setField(FIELDS.LEAD_SCORE, 0);
  }

  // --- Always safe to update: describes the most recent event, not a
  // cumulative/regressable state ---
  setField(FIELDS.LAST_ACTIVITY, `Wix Form Submission — ${new Date().toISOString()}`);

  // --- Campaign: submitted campaign, falling back to utmCampaign ---
  const campaign = normalize(body.campaign) || normalize(body.utmCampaign);
  setField(FIELDS.CAMPAIGN, campaign);

  // --- Event Date: DATE field, pass through whatever format Wix sends;
  // GHL accepts several common date formats (see create-contact's own
  // dateOfBirth field for the documented accepted list) — not
  // reformatted/validated further here, since doing so risks silently
  // misinterpreting an ambiguous DD/MM vs MM/DD date rather than just
  // passing through what a structured Wix date picker already normalized.
  setField(FIELDS.EVENT_DATE, normalize(body.eventDate));

  // --- Event Type: only when it matches a real option ---
  if (normalize(body.eventType)) {
    const matched = matchOption(body.eventType, FIELD_OPTIONS.EVENT_TYPE);
    if (matched) setField(FIELDS.EVENT_TYPE, matched);
    else unmapped.push({ label: 'Event Type', value: normalize(body.eventType) });
  }

  // --- Budget Range: only when it matches a real option ---
  if (normalize(body.budgetRange)) {
    const matched = matchOption(body.budgetRange, FIELD_OPTIONS.BUDGET_RANGE);
    if (matched) setField(FIELDS.BUDGET_RANGE, matched);
    else unmapped.push({ label: 'Budget Range', value: normalize(body.budgetRange) });
  }

  // --- Interest / Secondary Interest ---
  const { fieldOptions: interestOptions, tags: interestTags } = resolveInterests(body);
  if (normalize(body.interest) && !lookupInterest(body.interest)) {
    unmapped.push({ label: 'Interest', value: normalize(body.interest) });
  }
  if (normalize(body.secondaryInterest) && !lookupInterest(body.secondaryInterest)) {
    unmapped.push({ label: 'Secondary Interest', value: normalize(body.secondaryInterest) });
  }
  if (interestOptions.length) setField(FIELDS.INTEREST, interestOptions);

  // --- Marketing Consent: ONLY when explicitly yes/no. Never written for
  // "not supplied" — not even "Unknown" — because this field is merged
  // by id on update (see ghl-client.js), so omitting it entirely leaves
  // whatever the contact already had untouched; writing "Unknown"
  // unconditionally would instead silently downgrade a contact who
  // previously gave explicit consent back to "Unknown" on every repeat
  // submission that doesn't re-ask the question. ---
  const consentKey = normalizeKey(body.marketingConsent);
  if (['yes', 'true', '1'].includes(consentKey)) setField(FIELDS.MARKETING_CONSENT, 'Yes');
  else if (['no', 'false', '0'].includes(consentKey)) setField(FIELDS.MARKETING_CONSENT, 'No');
  else if (normalize(body.marketingConsent)) {
    // Something was submitted but didn't parse as yes/no — don't guess.
    unmapped.push({ label: 'Marketing Consent', value: normalize(body.marketingConsent) });
  }

  // --- Tags: always source-website + lead-new (new-lead's real name),
  // plus lead-type/interest tags only when explicitly recognized. ---
  const tags = [TAGS.SOURCE_WEBSITE, TAGS.LEAD_NEW];
  const typeTag = leadTypeTag(body.leadType);
  if (typeTag) tags.push(typeTag);
  else if (normalize(body.leadType)) unmapped.push({ label: 'Lead Type', value: normalize(body.leadType) });
  tags.push(...interestTags);

  const note = buildNote(body, unmapped);
  unmapped.forEach((u) => warnings.push(`${u.label} "${u.value}" did not match a canonical option — preserved in note only`));

  return {
    contactFields,
    customFields,
    tags: [...new Set(tags)],
    note,
    warnings,
  };
}

module.exports = {
  validateWixPayload,
  buildLeadPlan,
  // exported for tests
  splitName,
  matchOption,
  leadTypeTag,
  lookupInterest,
};
