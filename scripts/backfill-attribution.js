// One-off: fill marketing-attribution fields (gclid, utm_*, lead_channel, lead_origin) on
// EXISTING GHL contacts from CheckCherry leads + events created in the last 60 days, and add the
// google-ads tag to contacts whose channel is "Google Ads". DRY-RUN by default; --apply writes.
//
//   railway run node scripts/backfill-attribution.js                # dry run (npm run backfill:attribution)
//   railway run node scripts/backfill-attribution.js --days 30 --limit 20
//   railway run node scripts/backfill-attribution.js --apply        # only after reviewing the dry run
//
// Works with `railway run`: it reads CheckCherry and GHL directly and never opens the leads
// database. Needs CHECKCHERRY_API_KEY, GHL_API_KEY, GHL_LOCATION_ID, and (for --apply) the
// GHL_FIELD_<NAME>_ID variables printed by scripts/create-ghl-fields.js.
//
// Rules: matches by email, then phone (ghl-client findDuplicateContact); NEVER creates a contact;
// FIRST TOUCH WINS — a value is written only into a field that is currently blank (the same
// resolveFillBlank the live push uses); per person the OLDEST record carrying any attribution
// signal (a click id or a utm_*) is used; spam records are ignored; a person with no signal is
// "no attribution" and nothing is written for them (no "Direct / Unknown" guesses).
// Channel rule: attribution.js deriveChannel (only a click id proves "Google Ads").

const { extractAttribution, attributionValues, deriveChannel, GOOGLE_ADS_CHANNEL } = require('../attribution');
const { resolveFillBlank } = require('../ghl-lead-plan');
const { FIELDS, TAGS } = require('../ghl-canonical');

const firstOf = (v) => (Array.isArray(v) ? (v[0] || '') : (v || ''));
const maskEmail = (e) => { const [l = '', d = ''] = String(e).split('@'); return `${l.slice(0, 1)}***@${d.slice(0, 1)}***`; };
const hasSignal = (a) => !!(a.gclid || a.gbraid || a.wbraid || a.utmSource || a.utmMedium || a.utmCampaign || a.utmContent || a.utmTerm);

// CheckCherry /leads or /events record -> { email, phone, createdAt, status, kind, ...attribution }
function toCandidate(record, kind) {
  const attrs = (record && record.attributes) || record || {};
  const lead = kind === 'lead'
    ? { email: attrs.email, phone: attrs.phone_normalized || attrs.phone }
    : { email: firstOf(attrs.customer_emails), phone: firstOf(attrs.customer_phones) };
  return {
    kind, id: String((record && record.id) || attrs.id || ''), email: String(lead.email || '').trim().toLowerCase(),
    phone: String(lead.phone || '').trim(), createdAt: String(attrs.created_at || ''),
    source: 'CheckCherry', status: attrs.spam ? 'Spam' : 'New', spam: !!attrs.spam,
    ...extractAttribution(attrs),
  };
}

// Oldest-first, one candidate per person (email, else phone): the first record with a signal.
function pickPerPerson(candidates) {
  const sorted = [...candidates].filter((c) => !c.spam && (c.email || c.phone)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const people = new Map();
  for (const c of sorted) {
    const key = c.email || `tel:${c.phone}`;
    const p = people.get(key) || { key, candidate: null, records: 0 };
    p.records++;
    if (!p.candidate && hasSignal(c)) p.candidate = c;
    people.set(key, p);
  }
  return [...people.values()];
}

// deps: { findContact({email, phone}) -> full GHL contact | null, updateContact(id, body), addTags(id, tags) }
async function run(candidates, deps, { apply = false, limit = Infinity, pauseMs = 0, log = () => {}, fieldIds = FIELDS } = {}) {
  const people = pickPerPerson(candidates);
  const s = {
    mode: apply ? 'APPLY' : 'DRY-RUN', records: candidates.length, spamIgnored: candidates.filter((c) => c.spam).length,
    people: people.length, noAttribution: 0, notInGhl: 0, matched: 0, updated: 0, skipped: 0, valuesFilled: 0, tagged: 0, errors: 0,
    fieldsNotConfigured: [], byChannel: {},
  };
  const unconfigured = new Set();
  let handled = 0;
  for (const person of people) {
    const c = person.candidate;
    if (!c) { s.noAttribution++; continue; }
    if (handled >= limit) break;
    handled++;
    const channel = deriveChannel(c);
    s.byChannel[channel] = (s.byChannel[channel] || 0) + 1;
    try {
      const contact = await deps.findContact({ email: c.email, phone: c.phone });
      if (!contact) { s.notInGhl++; continue; }
      s.matched++;
      const entries = attributionValues(c).map((v) => {
        const id = fieldIds[v.fieldKey];
        if (!id) unconfigured.add(v.fieldKey);
        return { key: v.key, kind: 'custom', id: id || `pending:${v.fieldKey}`, value: v.value };
      });
      const fill = resolveFillBlank({ fillBlank: entries }, contact, { standalone: true });
      const writable = fill.customFields.filter((f) => !String(f.id).startsWith('pending:'));
      const hasTag = (contact.tags || []).some((t) => String(t).trim().toLowerCase() === TAGS.GOOGLE_ADS);
      const needsTag = channel === GOOGLE_ADS_CHANNEL && !hasTag;
      if (!fill.customFields.length && !needsTag) { s.skipped++; continue; }
      log(`${apply ? 'UPDATE' : 'WOULD UPDATE'} ${maskEmail(c.email || c.phone)} [${c.kind} ${c.id}] channel="${channel}" fill: ${fill.keys.join(', ') || '-'}${needsTag ? ' + tag google-ads' : ''}`);
      if (apply) {
        if (writable.length < fill.customFields.length) throw new Error('attribution GHL fields are not configured (set the GHL_FIELD_*_ID variables first)');
        if (writable.length) await deps.updateContact(contact.id, { customFields: writable });
        if (needsTag) await deps.addTags(contact.id, [TAGS.GOOGLE_ADS]);
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
      if (fill.customFields.length) { s.updated++; s.valuesFilled += fill.customFields.length; }
      if (needsTag) { s.tagged++; if (!fill.customFields.length) s.updated++; }
    } catch (err) {
      s.errors++;
      log(`ERROR ${maskEmail(c.email || c.phone)}: ${err.message}`);
    }
  }
  s.fieldsNotConfigured = [...unconfigured];
  return s;
}

function printSummary(s, log = console.log) {
  log(`\n=== Attribution backfill (${s.mode}) ===`);
  log(`CheckCherry records scanned: ${s.records} (spam ignored: ${s.spamIgnored}); distinct people: ${s.people}`);
  log(`no attribution (no click id / UTM on any record): ${s.noAttribution}`);
  log(`not found in GHL (by email, then phone): ${s.notInGhl}`);
  log(`matched in GHL: ${s.matched}`);
  log(`  ${s.mode === 'APPLY' ? 'updated' : 'would update'}: ${s.updated}  (${s.valuesFilled} blank field values filled; ${s.tagged} google-ads tags)`);
  log(`  skipped (already filled, nothing to change): ${s.skipped}`);
  log(`errors: ${s.errors}`);
  log(`channel of people with attribution: ${JSON.stringify(s.byChannel)}`);
  if (s.fieldsNotConfigured.length) log(`NOTE: GHL fields not configured yet (run scripts/create-ghl-fields.js, set the GHL_FIELD_*_ID vars): ${s.fieldsNotConfigured.join(', ')}`);
  if (s.mode !== 'APPLY') log('\nDry run only. Nothing was written. Re-run with --apply after reviewing.');
}

async function fetchAll(endpoint) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`https://api.checkcherry.com/api/v1/${endpoint}?page=${page}&per=100`, { headers: { 'Api-Key': process.env.CHECKCHERRY_API_KEY } });
    if (!res.ok) throw new Error(`CheckCherry ${endpoint} HTTP ${res.status}`);
    const body = await res.json();
    const records = Array.isArray(body) ? body : (body.leads || body.events || body.data || []);
    if (!records.length) break;
    all.push(...records);
    if (records.length < 100) break;
  }
  return all;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : def; };
  const days = arg('--days', 60);
  const limit = arg('--limit', Infinity);
  const apply = argv.includes('--apply');
  if (!process.env.CHECKCHERRY_API_KEY) throw new Error('CHECKCHERRY_API_KEY is not set (run via `railway run`)');
  const ghl = require('../ghl-client');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [leads, events] = await Promise.all([fetchAll('leads'), fetchAll('events')]);
  const candidates = [...leads.map((r) => toCandidate(r, 'lead')), ...events.map((r) => toCandidate(r, 'event'))]
    .filter((c) => c.createdAt && new Date(c.createdAt).toISOString() >= since);
  const summary = await run(candidates, {
    findContact: async ({ email, phone }) => {
      const found = (email && await ghl.findDuplicateContact({ email, phone: '' })) || (phone && await ghl.findDuplicateContact({ email: '', phone }));
      return found ? ((await ghl.getContact(found.id)) || found) : null;
    },
    updateContact: ghl.updateContact,
    addTags: ghl.addTags,
  }, { apply, limit, pauseMs: 300, log: console.log });
  printSummary(summary);
}

if (require.main === module) main().catch((err) => { console.error(err.message, err.body || ''); process.exit(1); });

module.exports = { run, toCandidate, pickPerPerson, printSummary };
