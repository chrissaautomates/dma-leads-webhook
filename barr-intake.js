// BuyAndRentRobots intake: POST /webhook/barr-lead (secured by a shared secret header) and the
// shared upsert that scripts/backfill-barr-leads.js reuses, so the endpoint and the backfill
// can never disagree about what a lead becomes in GHL.
//
// A lead has a `type`: supplier, renter or buyer. It is upserted into the DMA Events GHL
// location through the same field mapping as every other source (ghl-lead-plan.js), with:
//   - Lead Source "BuyAndRentRobots" (DMA Lead Source field, new contacts only) and the native
//     contact source "BuyAndRentRobots";
//   - exactly ONE tag: barr-supplier, barr-renter or barr-buyer, plus barr-event-passed when the
//     lead's event date is before today (so sales can filter them out). Never new-lead,
//     repeat-inquiry, a source-/interest-/lead-type tag or any DMA funnel tag (profile.exclusiveTags);
//   - matching on lowercase email; when the lead has no email, on company name.
//
// This path does NOT go through the DMA push guard (ghl-push.js assess), whose BuyAndRentRobots
// exclusion exists to keep these leads out of the DMA funnel. It never writes the leads database.
//
// Env vars:
//   BARR_INTAKE_SECRET  shared secret, sent as the x-barr-secret header. REQUIRED: unset -> every
//                       request is refused (503), never allowed through.
//   BARR_INTAKE_LIVE    true -> write to GHL. Default: dry-run (read-only lookups, nothing written).
//   GHL_PUSH_DISABLED   the existing kill switch; true -> 503, nothing evaluated.
//   GHL_API_KEY / GHL_LOCATION_ID  (see ghl-client.js)

const crypto = require('crypto');
const ghl = require('./ghl-client');
const { pushLeadToGhl, describeOutcome, getPushConfig } = require('./ghl-push');
const { FIELDS, TAGS } = require('./ghl-canonical');
const { testLeadReason } = require('./config');
const { toIsoDate } = require('./lead-shape');

const TYPES = ['supplier', 'renter', 'buyer'];
const LEAD_SOURCE = 'BuyAndRentRobots';
const WOULD_CREATE = Symbol('would-create');
const TYPE_LABEL = { supplier: 'Supplier Signup', renter: 'Rental Inquiry', buyer: 'Purchase Inquiry' };

const str = (v) => (v == null ? '' : String(v).trim());
const truthy = (v) => /^(1|true|yes|on)$/i.test(str(v));

// --- Secret -----------------------------------------------------------------

// -> 'ok' | 'unconfigured' | 'bad'. Constant-time compare; an unset secret fails closed.
function checkSecret(provided, env = process.env) {
  const expected = str(env.BARR_INTAKE_SECRET);
  if (!expected) return 'unconfigured';
  const a = crypto.createHash('sha256').update(str(provided)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

// --- Mode -------------------------------------------------------------------

// 'off' (kill switch) | 'dry-run' (default) | 'live'. No go-live cutoff: unlike the DMA push
// this is not reading a back catalog.
function intakeMode(env = process.env) {
  if (getPushConfig(env).disabled) return 'off';
  return truthy(env.BARR_INTAKE_LIVE) ? 'live' : 'dry-run';
}

// --- Normalising ------------------------------------------------------------

function normalizeType(v) {
  const t = str(v).toLowerCase();
  return TYPES.includes(t) ? t : null;
}

const normalizeEmail = (v) => str(v).toLowerCase();
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// First non-blank value among the named keys of a payload.
const pick = (body, ...keys) => {
  for (const k of keys) if (str(body[k])) return str(body[k]);
  return '';
};

// A caller payload (or a backfill CSV row mapped to the same keys) -> { lead, type, error }.
// `lead` is the normalized shape ghl-push.js toPlanBody expects. Unknown keys are ignored.
function normalizeLead(body) {
  const b = body || {};
  const type = normalizeType(b.type);
  if (!type) return { error: `type must be one of ${TYPES.join(', ')}` };
  const email = normalizeEmail(b.email);
  if (email && !looksLikeEmail(email)) return { error: 'email is not a valid address' };
  const company = pick(b, 'company', 'companyName');
  if (!email && !company) return { error: 'email or company is required (they are the match keys)' };

  const message = pick(b, 'message', 'notes', 'comments');
  const lead = {
    source: LEAD_SOURCE,
    name: pick(b, 'name', 'fullName') || [pick(b, 'firstName'), pick(b, 'lastName')].filter(Boolean).join(' '),
    email,
    phone: pick(b, 'phone', 'mobile'),
    company,
    city: pick(b, 'city', 'location'),
    interest: pick(b, 'interest'),
    eventType: pick(b, 'eventType'),
    eventDate: toIsoDate(pick(b, 'eventDate')) || pick(b, 'eventDate'),
    guestCount: pick(b, 'guestCount'),
    budgetRange: pick(b, 'budgetRange', 'budget'),
    campaign: pick(b, 'campaign', 'utmCampaign'),
    utmCampaign: pick(b, 'utmCampaign'),
    notes: message,
    // Kept in the note, never mapped: the BARR type is not a DMA Lead Type.
    extra: [`BuyAndRentRobots ${type}`, pick(b, 'pageUrl') && `Page: ${pick(b, 'pageUrl')}`, pick(b, 'website') && `Website: ${pick(b, 'website')}`]
      .filter(Boolean).join(' | '),
  };
  return { type, lead };
}

// --- Match ------------------------------------------------------------------

// Email (lowercased) when there is one, else company name. NEVER phone.
function matchKey(lead) {
  if (str(lead.email)) return { kind: 'email', key: normalizeEmail(lead.email) };
  return { kind: 'company', key: ghl.companyKey(lead.company) };
}

function lookupContact(lead) {
  return str(lead.email)
    ? ghl.findDuplicateContact({ email: normalizeEmail(lead.email), phone: '' })
    : ghl.findContactByCompany(lead.company);
}

// --- Lead Source option -----------------------------------------------------

// DMA Lead Source is a SINGLE_OPTIONS field; a value outside its options is stored as an orphan
// no report matches. So "BuyAndRentRobots" is written there only once that option exists in
// GHL; until then the native contact source still carries it and the result says so.
// A positive answer is cached for good, a negative one for a minute (so a backfill does not
// list the fields once per row, yet adding the option in GHL is picked up quickly).
const NEGATIVE_TTL_MS = 60000;
let leadSourceOptionCache = null; // { value, at }
const optionLabel = (o) => (typeof o === 'string' ? o : (o && (o.label || o.value || o.name)) || '');

async function leadSourceOptionExists(now = Date.now()) {
  const c = leadSourceOptionCache;
  if (c && (c.value || now - c.at < NEGATIVE_TTL_MS)) return c.value;
  const field = (await ghl.listCustomFields()).find((f) => f.id === FIELDS.LEAD_SOURCE);
  const options = field ? (field.picklistOptions || field.options || []).map(optionLabel) : [];
  const value = options.some((o) => str(o).toLowerCase() === LEAD_SOURCE.toLowerCase());
  leadSourceOptionCache = { value, at: now };
  return value;
}
const resetLeadSourceCache = () => { leadSourceOptionCache = null; };

// ISO event date (YYYY-MM-DD) strictly before today (UTC). Anything unreadable is not "passed".
function eventPassed(lead, now = new Date()) {
  const d = str(lead && lead.eventDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < now.toISOString().slice(0, 10);
}

function profileFor(type, { leadSourceOption, passed = false }) {
  const tags = passed ? [TAGS.BARR[type], TAGS.BARR_EVENT_PASSED] : [TAGS.BARR[type]];
  return {
    key: 'barr',
    leadSourceOption, // null while the picklist option is missing: the plan then skips the field
    sourceTag: TAGS.BARR[type],
    exclusiveTags: tags,
    nativeSource: LEAD_SOURCE,
    lastActivityLabel: `BuyAndRentRobots ${TYPE_LABEL[type]}`,
    noteLabel: `BuyAndRentRobots ${type}`,
  };
}

// --- The upsert -------------------------------------------------------------

// Creates or updates the GHL contact for one normalized lead. dryRun does read calls only.
//   seen  optional Map(matchKey -> contactId) of contacts written earlier in the same run (the
//         backfill): a repeat of a key is an update of that contact without trusting GHL's
//         search index to have caught up.
// -> { type, action, contactId, tags, route, matchedBy, leadSourceWritten, warnings, line }
async function upsertBarrLead(type, lead, { dryRun = true, seen = null } = {}) {
  const { kind, key } = matchKey(lead);
  const mapKey = `${kind}:${key}`;
  const leadSourceOption = (await leadSourceOptionExists()) ? LEAD_SOURCE : null;
  const profile = profileFor(type, { leadSourceOption, passed: eventPassed(lead) });

  // A key already created earlier in a DRY run has no contact id to look up: it is, by
  // definition, an update of the contact that run would have created.
  if (seen && seen.get(mapKey) === WOULD_CREATE) {
    return {
      type, action: 'update', contactId: null, tags: profile.exclusiveTags, route: 'exclusive-update', matchedBy: kind,
      leadSourceWritten: false, warnings: [],
      line: `UPDATE contact (same ${kind} as an earlier row, created earlier in this run) | ${kind}=${key} | tags=[${profile.exclusiveTags.join(', ')}]`,
    };
  }
  const lookup = async () => (seen && seen.has(mapKey) ? { id: seen.get(mapKey) } : lookupContact(lead));
  const outcome = await pushLeadToGhl(lead, { profile, dryRun, lookup });
  if (seen) seen.set(mapKey, outcome.contactId || WOULD_CREATE);

  const warnings = [...outcome.plan.warnings];
  if (!leadSourceOption) warnings.push(`DMA Lead Source has no "${LEAD_SOURCE}" option in GHL yet — not written (native source still set)`);
  return {
    type,
    action: outcome.action,
    contactId: outcome.contactId,
    tags: outcome.plan.tags,
    route: outcome.plan.route,
    matchedBy: kind,
    leadSourceWritten: !!leadSourceOption,
    warnings,
    line: describeOutcome(lead, profile, outcome),
  };
}

// --- HTTP -------------------------------------------------------------------

async function handleIntake(req, res) {
  const secret = checkSecret(req.get('x-barr-secret'));
  if (secret === 'unconfigured') return res.status(503).json({ ok: false, error: 'BARR intake is not configured' });
  if (secret === 'bad') return res.status(401).json({ ok: false, error: 'bad secret' });

  const mode = intakeMode();
  if (mode === 'off') return res.status(503).json({ ok: false, error: 'GHL push is disabled (kill switch)' });

  const { type, lead, error } = normalizeLead(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const testReason = testLeadReason(lead);
  if (testReason) return res.json({ ok: true, action: 'ignored', reason: testReason });

  try {
    const out = await upsertBarrLead(type, lead, { dryRun: mode !== 'live' });
    // Log line carries the email/name like the DMA push's own log lines; the response does not.
    console.log(`[barr-intake]${mode === 'live' ? '' : '[DRY-RUN]'} ${out.line}`);
    out.warnings.forEach((w) => console.warn(`[barr-intake] ${w}`));
    return res.json({ ok: true, mode, action: out.action, contactId: out.contactId, matchedBy: out.matchedBy, tags: out.tags });
  } catch (err) {
    // 502 so the caller knows to retry; nothing is queued here.
    console.error('[barr-intake] GHL upsert failed:', err.message);
    return res.status(502).json({ ok: false, error: 'GHL upsert failed' });
  }
}

module.exports = {
  TYPES, LEAD_SOURCE, eventPassed, checkSecret, intakeMode, normalizeType, normalizeLead, matchKey, upsertBarrLead,
  handleIntake, resetLeadSourceCache,
};
