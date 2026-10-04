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
//    DMA Lead Source = "Website Form", DMA Lead Status = "New",
//    Marketing Consent = "Unknown" (only when nothing explicit was supplied)
//    are only ever included in the payload when creating a new contact. Lead
//    Score is never written: it stays blank until real scoring exists. Sending them on every update would silently regress a
//    lead sales has already progressed (status "Hot", score 25) back down
//    to "New"/0 on every repeat Wix submission — a real, dangerous
//    regression, not just an "erase a blank value" case, so it's called out
//    separately from the general no-overwrite-with-blank rule below.
//    DMA Last Activity (e.g. "Wix Form Submission — <form> — <what they asked
//    for>") is the one exception: it
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
// 5. Marketing consent: an explicit yes/no answer is written as Yes/No. When
//    nothing explicit was supplied, "Unknown" is written ONLY on a brand-new
//    contact (so the field is never blank on a fresh lead). It is never
//    written on an existing contact: the field is merged by id on update, so
//    writing "Unknown" there would silently downgrade a contact who had given
//    explicit consent.
//
// 7. FILL-BLANK (plan.fillBlank). For an existing, non-advanced contact the
//    plan also lists every mapped value as a candidate to fill IF the contact's
//    field is currently blank (see resolveFillBlank). Never overwrites, never
//    includes defaults (Lead Source/Status/Consent=Unknown) or Last Activity.
//    Advanced / dead-deal contacts get an empty fillBlank.

const { FIELDS, FIELD_OPTIONS, TAGS, INTEREST_MAP, EVENT_TYPE_ALIASES } = require('./ghl-canonical');
const { parseConsent, toIsoDate, parseGuestCount } = require('./lead-shape');

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
  const key = squash(value);
  if (!key) return null;
  return options.find((opt) => squash(opt) === key) || null;
}

// Comparison key tolerant of case, spacing, underscores (Meta exports
// "product_launch") and dash variants ("$2,500 – $5,000" vs "$2,500-$5,000").
function squash(value) {
  return normalizeKey(value).replace(/[\u2012-\u2015\u2212]/g, '-').replace(/[_\s]+/g, '');
}

function matchEventType(value) {
  const direct = matchOption(value, FIELD_OPTIONS.EVENT_TYPE);
  if (direct) return direct;
  const key = normalizeKey(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return EVENT_TYPE_ALIASES[key] || null;
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
  const key = normalizeKey(value).replace(/[_\s]+/g, ' ');
  if (!key) return null;
  return INTEREST_MAP[key] || null;
}

// An interest answer may hold several choices ("Glambot, Robotics" — a multi-
// select). Whole-string match first; otherwise split on , ; | / newline and
// look each piece up. Returns { hits: [{token, entry}], unmatched: [token] }.
function interestTokens(value) {
  const whole = lookupInterest(value);
  if (whole) return { hits: [{ token: normalize(value), entry: whole }], unmatched: [] };
  const tokens = normalize(value).split(/[,;|\n]+|\s+and\s+/i).map((t) => t.trim()).filter(Boolean);
  const hits = [];
  const unmatched = [];
  tokens.forEach((t) => {
    const entry = lookupInterest(t);
    if (entry) hits.push({ token: t, entry });
    else unmatched.push(t);
  });
  return { hits, unmatched };
}

// Builds the DMA_Interest MULTIPLE_OPTIONS value and the interest-* tags to
// apply, from `interest` and `secondaryInterest`. Both are looked up
// independently and only included when explicitly recognized — this is
// where "secondary interest" lives, per Phase 1's design (DMA_Interest is
// multi-select specifically so a second value doesn't need its own field).
function resolveInterests(body) {
  const hits = [...interestTokens(body.interest).hits, ...interestTokens(body.secondaryInterest).hits].map((h) => h.entry);
  const fieldOptions = [...new Set(hits.map((h) => h.fieldOption))];
  const tags = [...new Set(hits.map((h) => h.tag).filter(Boolean))];
  return { fieldOptions, tags };
}

// Free-text note: the original message, plus (only when present) any
// submitted value that didn't cleanly map to a canonical field option —
// preserved here rather than dropped, per design decision #4 above.
function buildNote(body, unmapped, noteLabel, notedGuestCount) {
  const lines = [];
  if (normalize(body.message)) lines.push(`Message: ${normalize(body.message)}`);
  // Guest Count only lands in the note when it can't be written as a number
  // (no field configured yet, or a range/text answer). See buildLeadPlan.
  if (notedGuestCount) lines.push(`Guest Count (submitted): ${notedGuestCount}`);
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
  // Every mapped (non-default) value, tagged with its shape key, so the
  // fill-blank pass and the backfill report can reason per field.
  const mapped = [];
  function setField(id, value, key) {
    if (!id) return; // field not created in GHL yet (see FIELDS.GUEST_COUNT / LEAD_TYPE)
    if (value === undefined || value === null || value === '') return;
    customFields.push({ id, fieldValue: value });
    if (key) mapped.push({ key, kind: 'custom', id, value });
  }
  Object.entries({ city: 'city', company: 'companyName', phone: 'phone' }).forEach(([key, field]) => {
    if (contactFields[field]) mapped.push({ key, kind: 'contact', field, value: contactFields[field] });
  });

  // --- Consent: explicit answer, else "Unknown" on a NEW contact only
  // (design decision #5) ---
  const consentRaw = normalize(body.marketingConsent);
  const consent = parseConsent(consentRaw);
  if (consentRaw && !consent) unmapped.push({ label: 'Marketing Consent', value: consentRaw });

  // --- New-lead-only defaults (see design decision #1). Lead Score is
  // intentionally NOT written: blank until real scoring exists. ---
  if (isNewContact) {
    setField(FIELDS.LEAD_SOURCE, profile.leadSourceOption);
    setField(FIELDS.LEAD_STATUS, 'New');
    if (!consent) setField(FIELDS.MARKETING_CONSENT, 'Unknown');
  }

  // --- Always safe to update: describes the most recent event, not a
  // cumulative/regressable state ---
  setField(FIELDS.LAST_ACTIVITY, `${describeActivity(body, profile)} — ${new Date().toISOString()}`);

  // --- Campaign: submitted campaign, falling back to utmCampaign ---
  setField(FIELDS.CAMPAIGN, normalize(body.campaign) || normalize(body.utmCampaign), 'campaign');

  // --- Event Date: DATE field. Mappers normalize to ISO; anything still not
  // an unambiguous date stays in the note rather than risk a day/month swap.
  if (normalize(body.eventDate)) {
    const iso = toIsoDate(body.eventDate);
    if (iso) setField(FIELDS.EVENT_DATE, iso, 'eventDate');
    else unmapped.push({ label: 'Event Date', value: normalize(body.eventDate) });
  }

  // --- Event Type: only when it matches a real option (or a known alias) ---
  if (normalize(body.eventType)) {
    const matched = matchEventType(body.eventType);
    if (matched) setField(FIELDS.EVENT_TYPE, matched, 'eventType');
    else unmapped.push({ label: 'Event Type', value: normalize(body.eventType) });
  }

  // --- Budget Range: only when it matches a real option ---
  if (normalize(body.budgetRange)) {
    const matched = matchOption(body.budgetRange, FIELD_OPTIONS.BUDGET_RANGE);
    if (matched) setField(FIELDS.BUDGET_RANGE, matched, 'budgetRange');
    else unmapped.push({ label: 'Budget Range', value: normalize(body.budgetRange) });
  }

  // --- Guest Count (NUMERICAL): a plain number is written; a range writes its
  // lower bound and keeps the original answer in the note; no field configured
  // or no number at all -> note only. ---
  let notedGuestCount = '';
  if (normalize(body.guestCount)) {
    const g = parseGuestCount(body.guestCount);
    if (g.value !== null && FIELDS.GUEST_COUNT) {
      setField(FIELDS.GUEST_COUNT, g.value, 'guestCount');
      if (!g.exact) notedGuestCount = normalize(body.guestCount);
    } else {
      notedGuestCount = normalize(body.guestCount);
    }
  }

  // --- Interest / Secondary Interest (multi-select; every recognized choice) ---
  const { fieldOptions: interestOptions, tags: interestTags } = resolveInterests(body);
  [['Interest', body.interest], ['Secondary Interest', body.secondaryInterest]].forEach(([label, value]) => {
    const { unmatched } = interestTokens(value);
    if (unmatched.length) unmapped.push({ label, value: unmatched.join(', ') });
  });
  if (interestOptions.length) setField(FIELDS.INTEREST, interestOptions, 'interest');
  const interestSet = interestTokens(body.interest).hits.length > 0;
  const secondaryInterestSet = interestTokens(body.secondaryInterest).hits.length > 0;

  // --- Lead Type (single select) ---
  const leadTypeKey = normalizeKey(body.leadType);
  const leadTypeOption = FIELD_OPTIONS.LEAD_TYPE.find((o) => o.toLowerCase() === leadTypeKey) || null;
  if (leadTypeOption) setField(FIELDS.LEAD_TYPE, leadTypeOption, 'leadType');

  // --- Owner (single select; only a value matching a configured option) ---
  if (normalize(body.owner)) {
    const matched = matchOption(body.owner, FIELD_OPTIONS.OWNER);
    if (matched) setField(FIELDS.OWNER, matched, 'owner');
    else unmapped.push({ label: 'Owner', value: normalize(body.owner) });
  }

  // --- Marketing Consent: explicit answers only (the "Unknown" default for a
  // new contact was set above) ---
  if (consent) setField(FIELDS.MARKETING_CONSENT, consent, 'marketingConsent');

  // --- Tags: the source tag always; new-lead only through the gate in
  // design decision #6; lead-type/interest tags only when recognized. ---
  const tags = [profile.sourceTag];
  const newLead = decideNewLead(body, { isNewContact, profile, context });
  if (newLead.applied) tags.push(TAGS.LEAD_NEW);
  const typeTag = leadTypeTag(body.leadType);
  if (typeTag) tags.push(typeTag);
  else if (normalize(body.leadType)) unmapped.push({ label: 'Lead Type', value: normalize(body.leadType) });
  tags.push(...interestTags);

  const note = buildNote(body, unmapped, profile.noteLabel, notedGuestCount);
  unmapped.forEach((u) => warnings.push(`${u.label} "${u.value}" did not match a canonical option — preserved in note only`));

  // ADVANCED (skip) or DEAD-DEAL (reengage) existing contact: minimal update —
  // last-activity + note only. No standard field changes, no other custom
  // fields, nothing to fill. Advanced gets no tags at all; a dead deal gets
  // only the re-engagement tag (not re-added if it already has it).
  if ((context.advancedReason || context.reengageReason) && !isNewContact) {
    const reengage = !context.advancedReason;
    return {
      contactFields: {},
      customFields: customFields.filter((f) => f.id === FIELDS.LAST_ACTIVITY),
      fillBlank: [],
      interestSet: false,
      secondaryInterestSet: false,
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
    // Existing, non-advanced contacts only: candidates to write where the
    // contact's field is blank. See resolveFillBlank().
    fillBlank: isNewContact ? [] : mapped,
    interestSet,
    secondaryInterestSet,
    tags: [...new Set(tags)],
    note,
    warnings,
    newLead,
    route: newLead.applied ? 'new-lead' : 'no-new-lead',
  };
}

// DMA Last Activity text: the source label, the form it came from, and what
// they asked for — e.g. "Wix Form Submission — Digital Mirror Homepage —
// Glambot, Robotics". The timestamp is appended by the caller.
function describeActivity(body, profile) {
  const parts = [profile.lastActivityLabel];
  if (normalize(body.formName)) parts.push(normalize(body.formName));
  const asked = [body.interest, body.secondaryInterest].map(normalize).filter(Boolean).join(', ')
    || normalize(body.eventType);
  if (asked) parts.push(asked.length > 120 ? `${asked.slice(0, 117)}...` : asked);
  return parts.join(' — ');
}

// --- Fill-blank -------------------------------------------------------------

// Current value of one custom field on a GHL contact ('' when absent/blank).
function customFieldValue(contact, fieldId) {
  const entry = (contact.customFields || contact.customField || []).find((f) => f && f.id === fieldId);
  if (!entry) return '';
  const v = entry.value !== undefined ? entry.value : entry.fieldValue;
  return String(Array.isArray(v) ? v[0] || '' : v == null ? '' : v).trim();
}

// Which plan.fillBlank entries to actually send for this existing contact:
// only those whose field is blank on the contact AND that the plan isn't
// already writing in customFields/contactFields (pass { standalone: true } when
// those writes are NOT being sent — the backfill sends only the fill). Returns
// { contactFields, customFields, keys } ready to merge into the update body.
function resolveFillBlank(plan, contact, { standalone = false } = {}) {
  const out = { contactFields: {}, customFields: [], keys: [] };
  const alreadyCustom = new Set(standalone ? [] : (plan.customFields || []).map((f) => f.id));
  const planContact = standalone ? {} : (plan.contactFields || {});
  (plan.fillBlank || []).forEach((entry) => {
    if (entry.kind === 'contact') {
      if (normalize(contact[entry.field]) || planContact[entry.field] !== undefined) return;
      out.contactFields[entry.field] = entry.value;
    } else {
      if (alreadyCustom.has(entry.id) || customFieldValue(contact, entry.id)) return;
      out.customFields.push({ id: entry.id, fieldValue: entry.value });
    }
    out.keys.push(entry.key);
  });
  return out;
}

// Fields the backfill report tracks: shape key -> where it lives on a contact.
// (Interest / secondaryInterest share one multi-select field.)
const TRACKED_FIELDS = [
  { key: 'eventDate', kind: 'custom', id: FIELDS.EVENT_DATE },
  { key: 'eventType', kind: 'custom', id: FIELDS.EVENT_TYPE },
  { key: 'guestCount', kind: 'custom', id: FIELDS.GUEST_COUNT },
  { key: 'budgetRange', kind: 'custom', id: FIELDS.BUDGET_RANGE },
  { key: 'city', kind: 'contact', field: 'city' },
  { key: 'interest', kind: 'custom', id: FIELDS.INTEREST },
  { key: 'leadType', kind: 'custom', id: FIELDS.LEAD_TYPE },
  { key: 'marketingConsent', kind: 'custom', id: FIELDS.MARKETING_CONSENT },
  { key: 'campaign', kind: 'custom', id: FIELDS.CAMPAIGN },
  { key: 'owner', kind: 'custom', id: FIELDS.OWNER },
];

function isBlankOnContact(contact, tracked) {
  if (tracked.kind === 'contact') return !normalize(contact[tracked.field]);
  if (!tracked.id) return true; // field not created yet -> blank by definition
  const entry = (contact.customFields || contact.customField || []).find((f) => f && f.id === tracked.id);
  if (!entry) return true;
  const v = entry.value !== undefined ? entry.value : entry.fieldValue;
  return Array.isArray(v) ? v.length === 0 : !normalize(v);
}

// The 19 standard fields a lead is judged on, under their GHL names. `Contact` is
// the person's name (set when first or last name is written), `Mobile` is the
// phone. Lead Score is in the schema but never written (no real scoring yet), so
// it is reported as "not written by design", never as blank. Interested In and
// Secondary Interest share one multi-select field in GHL; each counts as set when
// its own answer matched an option (plan.interestSet / plan.secondaryInterestSet).
const STANDARD_FIELDS = [
  { name: 'Lead Source', id: FIELDS.LEAD_SOURCE },
  { name: 'Campaign', id: FIELDS.CAMPAIGN },
  { name: 'Lead Type', id: FIELDS.LEAD_TYPE },
  { name: 'Company', contact: ['companyName'] },
  { name: 'Contact', contact: ['firstName', 'lastName'] },
  { name: 'Email', contact: ['email'] },
  { name: 'Mobile', contact: ['phone'] },
  { name: 'Event Date', id: FIELDS.EVENT_DATE },
  { name: 'City', contact: ['city'] },
  { name: 'Guest Count', id: FIELDS.GUEST_COUNT },
  { name: 'Interested In', plan: 'interestSet' },
  { name: 'Secondary Interest', plan: 'secondaryInterestSet' },
  { name: 'Budget Range', id: FIELDS.BUDGET_RANGE },
  { name: 'Event Type', id: FIELDS.EVENT_TYPE },
  { name: 'Lead Score', byDesign: true },
  { name: 'Sales Owner', id: FIELDS.OWNER },
  { name: 'Status', id: FIELDS.LEAD_STATUS },
  { name: 'Last Activity', id: FIELDS.LAST_ACTIVITY },
  { name: 'Marketing Consent', id: FIELDS.MARKETING_CONSENT },
];
const STANDARD_FIELD_COUNT = STANDARD_FIELDS.length; // 19

// Which of the 19 this push writes ("set"), which it does not ("blank"), and the
// by-design exception, counting what the plan sends plus any fill-blank
// additions. For the dry-run logs.
function standardFieldReport(plan, fill) {
  const contact = { ...plan.contactFields, ...((fill && fill.contactFields) || {}) };
  const ids = new Set([...plan.customFields, ...((fill && fill.customFields) || [])].map((f) => f.id));
  const set = [];
  const blank = [];
  const notWritten = [];
  STANDARD_FIELDS.forEach((f) => {
    if (f.byDesign) { notWritten.push(f.name); return; }
    let isSet;
    if (f.contact) isSet = f.contact.some((k) => contact[k]);
    else if (f.plan) isSet = !!plan[f.plan];
    else isSet = !!(f.id && ids.has(f.id));
    (isSet ? set : blank).push(f.name);
  });
  return { set, blank, notWritten };
}

module.exports = {
  standardFieldReport,
  STANDARD_FIELD_COUNT,
  buildLeadPlan,
  decideNewLead,
  resolveFillBlank,
  customFieldValue,
  isBlankOnContact,
  TRACKED_FIELDS,
  // exported for tests
  splitName,
  matchOption,
  matchEventType,
  leadTypeTag,
  lookupInterest,
};
