// Lead -> GHL business logic shared by every source (Wix Forms, Meta Ads,
// Google Ads, CheckCherry): maps a lead onto DMA Events' canonical GHL
// fields/tags, and decides what to write for a brand-new contact vs. an
// existing one. What differs per source (Lead Source label, source tag,
// last-activity label, new-lead policy) lives in a `profile` — see
// SOURCE_PROFILES in ghl-push.js — so none of this logic is duplicated. Pure functions only —
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
// 3. The Lead Source custom field is set from the profile, always to a real
//    picklist option (see FIELD_OPTIONS.LEAD_SOURCE in ghl-canonical.js).
//
// 4. Values that don't match a canonical picklist option (event type,
//    budget range, interest) are never force-fit into the field. They're
//    preserved in the contact note instead, alongside any free-text
//    message, so nothing Wix sent is silently lost — just not written
//    somewhere it would corrupt reporting.
//
// 6. THE new-lead TAG IS THE GATE INTO THE NURTURE FUNNEL, so it is applied
//    only when ALL of these hold: the source's own policy allows it
//    (profile.applyNewLead — CheckCherry refuses when a proposal exists),
//    the contact isn't already in another bucket (decided by ghl-push.js and
//    passed in as context.advancedReason / context.reengageReason), and —
//    for an EXISTING contact — it doesn't already carry the tag (never
//    re-applied on an update). Three destinations, no overlap:
//      new-lead     brand-new / cold contacts        -> cold nurture sequence
//      reengage     dead deals (dead-deal tags, Lead Status Lost / Not Ready)
//                   -> tag newsletter-reengagement ONLY (monthly newsletter
//                   path; never new-lead)
//      skip         active / booked (advanced)       -> no tags at all
//    Reengage and skip contacts get a MINIMAL update: last-activity + note,
//    no other field changes.
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
function buildNote(body, unmapped, noteLabel) {
  const lines = [];
  if (normalize(body.message)) lines.push(`Message: ${normalize(body.message)}`);
  if (normalize(body.guestCount)) lines.push(`Guest Count (no canonical field for this yet): ${normalize(body.guestCount)}`);
  (body.noteLines || []).forEach((l) => { if (normalize(l)) lines.push(normalize(l)); });
  unmapped.forEach(({ label, value }) => {
    lines.push(`${label} (submitted value did not match a canonical option): ${value}`);
  });
  if (!lines.length) return null;
  const out = [`Submitted via ${noteLabel}.`, ...lines];
  if (normalize(body.pageUrl)) out.push(`Page: ${normalize(body.pageUrl)}`);
  return out.join('\n');
}

// The single place the new-lead gate (design decision #6) is decided.
function decideNewLead(lead, { isNewContact, profile, context }) {
  if (context.advancedReason && !isNewContact) {
    return { applied: false, reason: `contact already advanced (${context.advancedReason})` };
  }
  if (context.reengageReason && !isNewContact) {
    return { applied: false, reason: `dead deal (${context.reengageReason}) — routed to ${TAGS.NEWSLETTER_REENGAGEMENT}, not new-lead` };
  }
  // Cross-source proposal gate: if CheckCherry has a proposal/booking for this
  // email, NO source may tag new-lead — the more advanced signal always wins,
  // whichever door the lead came through. (context.proposal comes from
  // ghl-push.js; absent in pure unit tests.)
  if (context.proposal && context.proposal.has) {
    return { applied: false, reason: 'CheckCherry already has a proposal/booking for this email' };
  }
  if (profile.applyNewLead) {
    const policy = profile.applyNewLead({ lead, context });
    if (!policy.allow) return { applied: false, reason: policy.reason };
  }
  if (!isNewContact && context.hasNewLeadTag) {
    return { applied: false, reason: 'existing contact already has the new-lead tag (not re-applied)' };
  }
  return { applied: true, reason: isNewContact ? 'new contact' : 'existing contact, not advanced' };
}

// Core mapping function. `isNewContact` must be determined by the caller
// (ghl-client.js's findDuplicateContact result) BEFORE calling this — see
// design decision #1 above for why new-vs-existing changes what gets
// written, not just how it's written.
//
// options.profile — { leadSourceOption, sourceTag, nativeSource,
//   lastActivityLabel, noteLabel, applyNewLead({lead, context}) }
// options.context — { proposal: {known, has}, advancedReason: string|null, reengageReason: string|null,
//   hasNewLeadTag: bool, hasReengageTag: bool,
//   proposalEmails: Set|null } — facts about the existing contact / source
//   state, gathered by ghl-push.js (this function stays pure).
//
// Returns:
//   { contactFields, customFields, tags, note, warnings, newLead, route }
// where route is 'new-lead' | 'no-new-lead' (source policy, e.g. CheckCherry has a
// proposal) | 'reengage' | 'skip'
// where newLead is { applied, reason } — why the new-lead tag was or wasn't
// applied (surfaced in dry-run output).
// where contactFields/customFields are ready to hand to ghl-client.js's
// createContact/updateContact, tags is an array of tag name strings ready
// for addTags(), note is a string or null ready for createNote(), and
// warnings is a list of human-readable strings about anything that
// couldn't be mapped (for logging — never exposed to the Wix caller).
function buildLeadPlan(body, { isNewContact, profile, context = {} }) {
  if (!profile) throw new Error('buildLeadPlan requires a source profile');
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
  if (isNewContact && profile.nativeSource) contactFields.source = profile.nativeSource;

  const customFields = [];
  function setField(id, value) {
    if (value === undefined || value === null || value === '') return;
    customFields.push({ id, fieldValue: value });
  }

  // --- New-lead-only defaults (see design decision #1) ---
  if (isNewContact) {
    setField(FIELDS.LEAD_SOURCE, profile.leadSourceOption);
    setField(FIELDS.LEAD_STATUS, 'New');
    setField(FIELDS.LEAD_SCORE, 0);
  }

  // --- Always safe to update: describes the most recent event, not a
  // cumulative/regressable state ---
  setField(FIELDS.LAST_ACTIVITY, `${profile.lastActivityLabel} — ${new Date().toISOString()}`);

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

  // --- Tags: the source tag always; new-lead only through the gate in
  // design decision #6; lead-type/interest tags only when recognized. ---
  const tags = [profile.sourceTag];
  const newLead = decideNewLead(body, { isNewContact, profile, context });
  if (newLead.applied) tags.push(TAGS.LEAD_NEW);
  const typeTag = leadTypeTag(body.leadType);
  if (typeTag) tags.push(typeTag);
  else if (normalize(body.leadType)) unmapped.push({ label: 'Lead Type', value: normalize(body.leadType) });
  tags.push(...interestTags);

  const note = buildNote(body, unmapped, profile.noteLabel);
  unmapped.forEach((u) => warnings.push(`${u.label} "${u.value}" did not match a canonical option — preserved in note only`));

  // ADVANCED (skip) or DEAD-DEAL (reengage) existing contact: minimal update —
  // last-activity + note only. No standard field changes, no other custom
  // fields. Advanced gets no tags at all; a dead deal gets only the
  // re-engagement tag (not re-added if it already has it).
  if ((context.advancedReason || context.reengageReason) && !isNewContact) {
    const reengage = !context.advancedReason;
    return {
      contactFields: {},
      customFields: customFields.filter((f) => f.id === FIELDS.LAST_ACTIVITY),
      tags: reengage && !context.hasReengageTag ? [TAGS.NEWSLETTER_REENGAGEMENT] : [],
      note,
      warnings,
      newLead,
      route: reengage ? 'reengage' : 'skip',
    };
  }

  return {
    contactFields,
    customFields,
    tags: [...new Set(tags)],
    note,
    warnings,
    newLead,
    route: newLead.applied ? 'new-lead' : 'no-new-lead',
  };
}

module.exports = {
  buildLeadPlan,
  decideNewLead,
  // exported for tests
  splitName,
  matchOption,
  leadTypeTag,
  lookupInterest,
};
