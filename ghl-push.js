// Pushes newly-captured leads (Wix Forms, Meta Ads, Google Ads, CheckCherry)
// into the DMA Events GHL location: find-or-create the contact, set canonical
// fields, apply tags, add a note. ONE shared implementation — every source
// goes through pushLeadToGhl(); what differs per source is only its profile.
//
// SAFETY MODEL (all three must hold for anything to be sent):
//   1. Mode. Default is DRY-RUN: evaluates everything (including read-only GHL
//      lookups so the log shows exactly what it WOULD do) and sends nothing.
//      Live only when GHL_PUSH_LIVE=true.
//   2. Kill switch. GHL_PUSH_DISABLED=true stops all evaluation and pushing.
//   3. Go-live cutoff. GHL_PUSH_CUTOFF_DATE (YYYY-MM-DD) is REQUIRED for live
//      mode (live without it refuses to push); rows received before it never
//      push. Combined with the `legacy` stamp from db.js's migration, the back
//      catalog cannot be sent.
//
// A row is pushed at most once: db.js stores ghl_pushed on the row (NULL =
// pending). Only a still-pending row is ever considered, so a 15-minute sync
// re-reading the same source history never re-pushes anything.
//
// Env vars (all optional except where noted):
//   GHL_PUSH_LIVE            true -> send for real (default: dry-run)
//   GHL_PUSH_DISABLED        true -> kill switch, nothing evaluated or sent
//   GHL_PUSH_CUTOFF_DATE     YYYY-MM-DD go-live date; required for live
//   GHL_CHECKCHERRY_SETTLE_MINUTES  hold a new CheckCherry lead this long (default 10)
//   GHL_API_KEY / GHL_LOCATION_ID  (see ghl-client.js)

const ghl = require('./ghl-client');
const { buildLeadPlan } = require('./ghl-lead-plan');
const { FIELDS, TAGS, ADVANCED_TAGS, DEAD_DEAL_TAGS, REENGAGE_STATUSES } = require('./ghl-canonical');
const { BARR_PATTERN, getGhlState, markGhlPushed, getProposalState, hasProposalEmail } = require('./db');

// --- Config / modes ---------------------------------------------------------

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

function getPushConfig(env = process.env) {
  const cutoffRaw = String(env.GHL_PUSH_CUTOFF_DATE || '').trim();
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(cutoffRaw) ? cutoffRaw : null;
  return {
    disabled: truthy(env.GHL_PUSH_DISABLED),
    live: truthy(env.GHL_PUSH_LIVE),
    cutoff,
    cutoffRaw,
  };
}

// 'off' | 'dry-run' | 'live'. Live without a valid cutoff resolves to 'off' —
// refusing is safer than guessing a cutoff.
function resolveMode(cfg) {
  if (cfg.disabled) return 'off';
  if (cfg.live) return cfg.cutoff ? 'live' : 'off';
  return 'dry-run';
}

function describeMode(env = process.env) {
  const cfg = getPushConfig(env);
  const mode = resolveMode(cfg);
  let detail = '';
  if (cfg.disabled) detail = ' (kill switch GHL_PUSH_DISABLED is on)';
  else if (cfg.live && !cfg.cutoff) detail = ` (GHL_PUSH_LIVE is on but GHL_PUSH_CUTOFF_DATE ${cfg.cutoffRaw ? `"${cfg.cutoffRaw}" is invalid` : 'is not set'} — refusing to push)`;
  return `${mode.toUpperCase()}${detail}, cutoff=${cfg.cutoff || 'none'}`;
}

// --- Source profiles --------------------------------------------------------

const SOURCE_PROFILES = {
  wix: {
    key: 'wix',
    leadSourceOption: 'Website Form',
    sourceTag: TAGS.SOURCE_WIX,
    nativeSource: 'Wix Form',
    lastActivityLabel: 'Wix Form Submission',
    noteLabel: 'Wix form',
  },
  meta: {
    key: 'meta',
    leadSourceOption: 'Meta Ad',
    sourceTag: TAGS.SOURCE_META,
    nativeSource: 'Meta Lead Form',
    lastActivityLabel: 'Meta Lead Form Submission',
    noteLabel: 'Meta lead form',
  },
  google: {
    key: 'google',
    leadSourceOption: 'Google Ad',
    sourceTag: TAGS.SOURCE_GOOGLE_ADS,
    nativeSource: 'Google Ads Lead Form',
    lastActivityLabel: 'Google Ads Lead Form Submission',
    noteLabel: 'Google Ads lead form',
  },
  checkcherry: {
    key: 'checkcherry',
    leadSourceOption: 'Check Cherry',
    sourceTag: TAGS.SOURCE_CHECKCHERRY,
    nativeSource: 'CheckCherry Lead',
    lastActivityLabel: 'CheckCherry Lead',
    noteLabel: 'CheckCherry',
    // new-lead ONLY when CheckCherry has no proposal/booking for this email.
    // Fails closed: with no proposal set (events feed unavailable) or no email
    // to check, the tag is withheld.
    applyNewLead({ lead, context }) {
      const set = context && context.proposalEmails;
      if (!set) return { allow: false, reason: 'CheckCherry proposal set unavailable (fail closed)' };
      const email = normEmail(lead.email);
      if (!email) return { allow: false, reason: 'no email to check against CheckCherry proposals' };
      if (set.has(email)) return { allow: false, reason: 'CheckCherry already has a proposal/booking for this email' };
      return { allow: true };
    },
  },
};

// Only these exact source labels push. Everything else — 'Chat Lead' (already
// in GHL), 'Manual entry', anything an arbitrary caller posts to /webhook/lead
// — maps to null and is never pushed.
function profileForSource(source) {
  const s = String(source || '').trim();
  if (/^Wix Form/i.test(s)) return SOURCE_PROFILES.wix;
  if (s === 'Meta Ads') return SOURCE_PROFILES.meta;
  if (s === 'Google Ads') return SOURCE_PROFILES.google;
  if (s === 'CheckCherry') return SOURCE_PROFILES.checkcherry;
  return null;
}

// --- Eligibility ------------------------------------------------------------

function normEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// BuyAndRentRobots exclusion. Uses the same keyword pattern the app uses to
// file leads under the BARR tab (BARR_PATTERN in db.js), but over EVERY text
// field of every source: db.js's computeTarget() routes CheckCherry / Chat Lead
// straight to their own tabs before the keyword check, so `target` alone can't
// be trusted to reveal a BARR lead. Over-excluding is the safe direction here.
function isBarrLead(lead, row) {
  if (row && row.target === 'BARR') return true;
  const haystack = [
    lead.source, lead.interest, lead.notes, lead.company,
    lead.utmSource, lead.utmMedium, lead.utmCampaign, lead.utmContent, lead.utmTerm,
  ].filter(Boolean).join(' ');
  return BARR_PATTERN.test(haystack);
}

// Spam: a lead marked Spam — by CheckCherry's own spam flag (mapped to status
// 'Spam' in sync.js) or by staff in /admin — must never enter the funnel. Checks
// both the stored row (fresh: catches a lead marked spam AFTER it was inserted
// but before it was pushed) and the incoming lead.
function isSpamLead(lead, row) {
  const isSpam = (v) => String(v == null ? '' : v).trim().toLowerCase() === 'spam';
  return isSpam(row && row.status) || isSpam(lead && lead.status);
}

// Does CheckCherry have a proposal/booking for this email? Applies to EVERY
// source, not just CheckCherry: the same person arriving through Wix / Meta /
// Google must not be tagged new-lead when a proposal already exists. The
// truth is the events feed; each successful CheckCherry cycle stores the set
// (db.js proposal_emails), so any source can ask.
//   requireFresh (CheckCherry's own leads): only this cycle's set counts —
//   if the events fetch failed, don't guess from a stale copy.
//   { known: false } -> the caller must not push (fail closed).
function proposalLookup(email, context, { requireFresh = false } = {}) {
  if (context && context.proposalEmails) {
    return { known: true, has: context.proposalEmails.has(email), from: 'this cycle' };
  }
  if (requireFresh) return { known: false, has: false, from: null };
  const state = getProposalState();
  if (state.loaded) return { known: true, has: hasProposalEmail(email), from: `stored set (${state.count} emails, loaded ${state.loadedAt} UTC)` };
  // Nothing stored yet. With no CheckCherry integration configured there is no
  // proposal source at all, so "no proposal" is the honest answer; otherwise
  // the first load simply hasn't happened yet -> wait (fail closed).
  if (!process.env.CHECKCHERRY_API_KEY) return { known: true, has: false, from: 'CheckCherry not configured' };
  return { known: false, has: false, from: null };
}

function settleWindowMinutes(env = process.env) {
  const raw = env.GHL_CHECKCHERRY_SETTLE_MINUTES;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

// Decides what to do with one row, without side effects.
//   { kind: 'exclude', terminal, reason }  permanent — mark the row
//   { kind: 'skip', reason }               not eligible now (pre-cutoff), re-check later
//   { kind: 'defer', reason }              eligible but missing input — retry next cycle
//   { kind: 'push', profile }
function assess(lead, row, cfg, context) {
  const profile = profileForSource(lead.source);
  if (!profile) return { kind: 'exclude', terminal: 'excluded_source', reason: `source "${lead.source || ''}" is not pushed to GHL` };
  if (isBarrLead(lead, row)) return { kind: 'exclude', terminal: 'excluded_barr', reason: 'BuyAndRentRobots lead — not for the DMA Events funnel' };
  if (isSpamLead(lead, row)) return { kind: 'exclude', terminal: 'excluded_spam', reason: 'lead is marked Spam — never enters the funnel' };
  if (cfg.cutoff && row && row.date_received < cfg.cutoff) {
    return { kind: 'skip', reason: `received ${row.date_received}, before cutoff ${cfg.cutoff}` };
  }
  if (!normEmail(lead.email) && !String(lead.phone || '').trim()) {
    return { kind: 'exclude', terminal: 'skipped_no_contact', reason: 'no email or phone to match/create a GHL contact' };
  }
  const isCheckCherry = profile.key === 'checkcherry';
  const proposal = proposalLookup(normEmail(lead.email), context, { requireFresh: isCheckCherry });
  if (!proposal.known) {
    return {
      kind: 'defer',
      reason: isCheckCherry
        ? 'CheckCherry events feed not loaded this cycle — cannot check for a proposal'
        : 'CheckCherry proposal set not loaded yet — cannot check this email for a proposal (fail closed)',
    };
  }
  if (isCheckCherry) {
    // Settle window: a proposal created minutes after the inquiry must land
    // before any tag is applied. A brand-new row waits until a later sync
    // cycle re-checks it against fresh events. (See syncCheckCherryAll.)
    const settleMinutes = settleWindowMinutes();
    const ageMinutes = row && row.created_at ? (Date.now() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`)) / 60000 : Infinity;
    if (ageMinutes < settleMinutes) {
      return { kind: 'defer', reason: `CheckCherry settle window (${settleMinutes} min) — re-checked next cycle against fresh events` };
    }
  }
  return { kind: 'push', profile, proposal };
}

// --- Advanced-contact guard -------------------------------------------------

const NOT_ADVANCED_STATUSES = ['new', 'nurture'];
const REENGAGE_STATUS_SET = new Set(REENGAGE_STATUSES.map((x) => x.toLowerCase()));

// Tag matching is EXACT-name (ghl-canonical.js): whole-tag equality, trimmed and
// case-insensitive — never a substring/keyword match.
const ADVANCED_TAG_SET = new Set(ADVANCED_TAGS.map((t) => t.trim().toLowerCase()));
const DEAD_DEAL_TAG_SET = new Set(DEAD_DEAL_TAGS.map((t) => t.trim().toLowerCase()));

function customFieldValue(contact, fieldId) {
  const entry = (contact.customFields || contact.customField || []).find((f) => f && f.id === fieldId);
  if (!entry) return '';
  const v = entry.value !== undefined ? entry.value : entry.fieldValue;
  return String(Array.isArray(v) ? v[0] || '' : v == null ? '' : v).trim();
}

const tagKey = (t) => String(t).trim().toLowerCase();

// Which of the three buckets an EXISTING contact is in:
//   { bucket: 'advanced', reason }  active / booked  -> skip (no tags)
//   { bucket: 'reengage', reason }  dead deal        -> newsletter-reengagement
//   { bucket: 'normal' }
// Precedence: anything active wins. An active tag OR an advanced Lead Status
// (beyond New/Nurture, other than Lost / Not Ready) makes the contact advanced
// even if it also carries a dead-deal tag or a Lost status. Only when nothing
// active is present do dead-deal tags / Lost / Not Ready route to re-engagement.
function classifyContact(contact) {
  const status = customFieldValue(contact, FIELDS.LEAD_STATUS);
  const statusKey = status.toLowerCase();
  const tags = contact.tags || [];

  const activeTag = tags.find((t) => ADVANCED_TAG_SET.has(tagKey(t)));
  if (activeTag) return { bucket: 'advanced', reason: `tag "${activeTag}"` };
  if (status && !NOT_ADVANCED_STATUSES.includes(statusKey) && !REENGAGE_STATUS_SET.has(statusKey)) {
    return { bucket: 'advanced', reason: `Lead Status = ${status}` };
  }
  const deadTag = tags.find((t) => DEAD_DEAL_TAG_SET.has(tagKey(t)));
  if (deadTag) return { bucket: 'reengage', reason: `tag "${deadTag}"` };
  if (status && REENGAGE_STATUS_SET.has(statusKey)) return { bucket: 'reengage', reason: `Lead Status = ${status}` };
  return { bucket: 'normal' };
}

// --- The shared push --------------------------------------------------------

// Adapts a stored/synced lead ({name, email, phone, company, location,
// interest, notes, utm*, source}) into the input buildLeadPlan expects.
// Free-text interest and location go to the note, not into structured fields:
// they aren't picklist values, and a venue city isn't the contact's city.
function toPlanBody(lead) {
  return {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    campaign: lead.utmCampaign,
    noteLines: [
      lead.interest && `Interest / form answers: ${lead.interest}`,
      lead.location && `Location: ${lead.location}`,
      lead.notes && `Notes: ${lead.notes}`,
      lead.source && `Original source: ${lead.source}`,
    ].filter(Boolean),
  };
}

// dryRun: performs only READ calls (duplicate lookup, get contact) so the
// result reflects what a live run would really do; sends nothing.
async function pushLeadToGhl(lead, { profile, context = {}, dryRun = true }) {
  const email = String(lead.email || '').trim();
  const phone = String(lead.phone || '').trim();

  const found = await ghl.findDuplicateContact({ email, phone });
  // Full contact (tags + customFields) — duplicate-search's shape is unverified.
  const existing = found ? ((await ghl.getContact(found.id)) || found) : null;
  const isNewContact = !existing;

  const cls = existing ? classifyContact(existing) : { bucket: 'normal' };
  const hasTag = (name) => (existing ? (existing.tags || []).some((t) => tagKey(t) === name) : false);
  const ctx = {
    ...context,
    advancedReason: cls.bucket === 'advanced' ? cls.reason : null,
    reengageReason: cls.bucket === 'reengage' ? cls.reason : null,
    hasNewLeadTag: hasTag(TAGS.LEAD_NEW),
    hasReengageTag: hasTag(TAGS.NEWSLETTER_REENGAGEMENT),
  };
  const plan = buildLeadPlan(toPlanBody(lead), { isNewContact, profile, context: ctx });
  const action = isNewContact ? 'create' : ((ctx.advancedReason || ctx.reengageReason) ? 'update-minimal' : 'update');
  const outcome = { action, contactId: existing ? existing.id : null, plan, advancedReason: ctx.advancedReason, reengageReason: ctx.reengageReason };
  if (dryRun) return { ...outcome, dryRun: true };

  let contactId;
  if (existing) {
    await ghl.updateContact(existing.id, { ...plan.contactFields, customFields: plan.customFields });
    contactId = existing.id;
  } else {
    const result = await ghl.createContact({ ...plan.contactFields, customFields: plan.customFields });
    contactId = result.contact.id;
  }
  if (plan.tags.length) await ghl.addTags(contactId, plan.tags);
  if (plan.note) await ghl.createNote(contactId, plan.note);
  return { ...outcome, contactId, dryRun: false };
}

// --- Logging ----------------------------------------------------------------

function describeOutcome(lead, profile, outcome) {
  const { plan } = outcome;
  const verb = { create: 'CREATE contact', update: 'UPDATE contact', 'update-minimal': 'UPDATE contact (MINIMAL: last-activity + note only)' }[outcome.action];
  return [
    `${verb}${outcome.contactId ? ` ${outcome.contactId}` : ''}`,
    `email=${lead.email || '-'}`,
    `name="${lead.name || ''}"`,
    `source="${lead.source}"`,
    `leadSource=${profile.leadSourceOption}`,
    `tags=[${plan.tags.join(', ')}]`,
    `new-lead: ${plan.newLead.applied ? 'YES' : 'NO'} (${plan.newLead.reason})`,
    `route=${plan.route}`,
    outcome.advancedReason ? `advanced: ${outcome.advancedReason}` : null,
    outcome.reengageReason ? `dead deal: ${outcome.reengageReason}` : null,
    plan.note ? 'note=yes' : 'note=no',
  ].filter(Boolean).join(' | ');
}

const dryRunLogged = new Set(); // row ids already logged this process — dry-run re-evaluates pending rows every cycle
let warnedLiveNoCutoff = false;

// --- Entry point for the syncs / webhook -----------------------------------

// Call right after upsertLead(). Never throws — a push problem must never fail
// a sync. `context` carries per-cycle source facts (CheckCherry's
// proposalEmails). Returns a short status string (used by tests / callers).
async function pushAfterUpsert(lead, result, context = {}) {
  try {
    const cfg = getPushConfig();
    const mode = resolveMode(cfg);
    if (mode === 'off') {
      if (cfg.live && !cfg.disabled && !warnedLiveNoCutoff) {
        warnedLiveNoCutoff = true;
        console.error(`[ghl-push] GHL_PUSH_LIVE is on but GHL_PUSH_CUTOFF_DATE is ${cfg.cutoffRaw ? `invalid ("${cfg.cutoffRaw}")` : 'not set'} — NOT pushing anything`);
      }
      return 'off';
    }
    if (!result || result.action === 'skipped_deleted') return 'deleted';

    const row = getGhlState(result.id);
    // Legacy / pushed / excluded rows are terminal. Only a pending (NULL) row
    // — freshly inserted, or inserted earlier but deferred/failed — proceeds.
    if (!row || row.ghl_pushed) return 'not-pending';

    const decision = assess(lead, row, cfg, context);
    const dry = mode === 'dry-run';

    if (decision.kind === 'skip') return 'skip';
    if (decision.kind === 'defer') {
      if (!dryRunLogged.has(`defer:${row.id}:${dry}`)) {
        dryRunLogged.add(`defer:${row.id}:${dry}`);
        console.log(`[ghl-push]${dry ? '[DRY-RUN]' : ''} DEFERRED ${lead.email || lead.name} — ${decision.reason}`);
      }
      return 'defer';
    }
    if (decision.kind === 'exclude') {
      if (dry) {
        if (!dryRunLogged.has(row.id)) {
          dryRunLogged.add(row.id);
          console.log(`[ghl-push][DRY-RUN] WOULD EXCLUDE ${lead.email || lead.name} (source="${lead.source}") — ${decision.reason}`);
        }
      } else {
        markGhlPushed(row.id, decision.terminal);
        console.log(`[ghl-push] EXCLUDED ${lead.email || lead.name} (source="${lead.source}") — ${decision.reason}`);
      }
      return decision.terminal;
    }

    // kind === 'push'
    if (dry && dryRunLogged.has(row.id)) return 'dry-run-seen';
    const outcome = await pushLeadToGhl(lead, { profile: decision.profile, context: { ...context, proposal: decision.proposal }, dryRun: dry });
    if (dry) {
      dryRunLogged.add(row.id);
      console.log(`[ghl-push][DRY-RUN] WOULD ${describeOutcome(lead, decision.profile, outcome)}`);
      return 'dry-run';
    }
    markGhlPushed(row.id, 'pushed');
    console.log(`[ghl-push] DONE ${describeOutcome(lead, decision.profile, outcome)}`);
    return 'pushed';
  } catch (err) {
    console.error(`[ghl-push] push failed for ${lead && (lead.email || lead.name)} — row stays pending, will retry next cycle:`, err.message);
    return 'error';
  }
}

// Read-only assessment of already-stored rows (used by the admin dry-run
// preview): what WOULD be done to each, ignoring their ghl_pushed state.
// Performs only read calls to GHL. Never sends or marks anything.
async function previewLead(lead, row, context = {}, cfg = getPushConfig()) {
  const decision = assess(lead, row, { ...cfg, cutoff: cfg.cutoff }, context);
  if (decision.kind !== 'push') return { verdict: decision.kind, reason: decision.reason };
  try {
    const outcome = await pushLeadToGhl(lead, { profile: decision.profile, context: { ...context, proposal: decision.proposal }, dryRun: true });
    return { verdict: 'would-push', line: describeOutcome(lead, decision.profile, outcome) };
  } catch (err) {
    return { verdict: 'error', reason: err.message };
  }
}

module.exports = {
  SOURCE_PROFILES,
  getPushConfig,
  resolveMode,
  describeMode,
  profileForSource,
  isBarrLead,
  isSpamLead,
  proposalLookup,
  assess,
  classifyContact,
  pushLeadToGhl,
  pushAfterUpsert,
  previewLead,
};
