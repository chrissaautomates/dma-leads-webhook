// The one normalized lead shape every source mapper fills and every consumer
// (db.js, ghl-push.js, the backfill) reads. Pure functions, no I/O.
//
// Standard fields, all strings, '' when unknown:
//   eventDate, eventType, guestCount, budgetRange, city, interest,
//   secondaryInterest, leadType, marketingConsent, campaign, owner
// Everything else on a lead (source, name, email, phone, company, location,
// notes, status, utm*, dateReceived) is unchanged. The values here are the RAW
// submitted answers (apart from eventDate, which mappers normalize to ISO);
// matching them against GHL picklists happens once, in ghl-lead-plan.js.

const SHAPE_FIELDS = [
  'eventDate', 'eventType', 'guestCount', 'budgetRange', 'city', 'interest',
  'secondaryInterest', 'leadType', 'marketingConsent', 'campaign', 'owner',
];

const str = (v) => String(v == null ? '' : v).trim();

// A lead with every shape field present (blank unless supplied).
function emptyShape() {
  const out = {};
  SHAPE_FIELDS.forEach((k) => { out[k] = ''; });
  return out;
}

// Merges the shape fields into a source lead object, trimming and defaulting.
function withShape(lead, shape = {}) {
  const out = { ...lead };
  SHAPE_FIELDS.forEach((k) => { out[k] = str(shape[k] !== undefined ? shape[k] : lead[k]); });
  return out;
}

// --- Label classification (Wix form labels, Meta/legacy "Label: value") ----

const RULES = [
  // Order matters: consent first (its wording mentions "email"), then the rest.
  ['marketingConsent', /(promotion|promotional|newsletter|subscribe|opt[\s-]?in|consent|marketing|send you (information|updates|offers)|can we (send|email|contact))/i],
  ['budgetRange', /budget/i],
  ['guestCount', /(guest|attendee|head ?count|how many (people|guests|attendees)|number of (people|guests|attendees)|expected attendance|group size)/i],
  ['eventDate', /(event date|date of (the |your )?event|when is (your|the) event|when are you (planning|hosting)|event_date|date and time|what date)/i],
  ['eventType', /(type of event|event type|kind of event|what are you planning|what type of|occasion|what is the event)/i],
  ['leadType', /(who are you|i am (a|an)|are you (a|an)|your role|type of (client|customer|organization|organisation)|company type)/i],
  ['city', /(\bcity\b|venue (city|location)|event (city|location)|where is (your|the) event)/i],
  ['interest', /(interested in|services?|looking for|which (booth|experience|product)|product|experience|what would you like)/i],
];

function classifyLabel(label) {
  const text = str(label);
  if (!text) return 'other';
  for (const [key, re] of RULES) if (re.test(text)) return key;
  return 'other';
}

// --- Value parsers -----------------------------------------------------------

// Explicit yes/no consent answer -> 'Yes' | 'No' | ''. Unrecognized -> ''
// (callers treat '' as "nothing explicit supplied").
function parseConsent(value) {
  const v = str(value).toLowerCase();
  if (!v) return '';
  if (/^(no|nope|false|0|unchecked|decline|opt[\s-]?out|do not|don't)\b/.test(v)) return 'No';
  if (/^(yes|yeah|true|1|checked|sure|agree|i agree|opt[\s-]?in|please|ok|okay)\b/.test(v)) return 'Yes';
  return '';
}

// Any common date -> 'YYYY-MM-DD', or '' when it can't be read unambiguously.
// ISO and ISO datetimes pass through. A/B/YYYY is read as MM/DD when the second
// part is >12, DD/MM when the first is >12, and otherwise per `order`
// ('mdy' | 'dmy'); with no order given an ambiguous date returns '' rather than
// risk swapping day and month.
function toIsoDate(value, { order } = {}) {
  const v = str(value);
  if (!v) return '';
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (m) return validDate(m[1], m[2], m[3]);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) return validDate(m[3], b, a);
    if (b > 12) return validDate(m[3], a, b);
    if (a === b) return validDate(m[3], a, b);
    if (order === 'mdy') return validDate(m[3], a, b);
    if (order === 'dmy') return validDate(m[3], b, a);
    return '';
  }
  const parsed = Date.parse(v); // "May 30, 2027" style
  if (!Number.isNaN(parsed) && /[a-z]{3}/i.test(v) && /\d{4}/.test(v)) {
    const d = new Date(parsed);
    return validDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return '';
}

function validDate(y, mo, d) {
  const year = Number(y); const month = Number(mo); const day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "150" -> 150; "100-150" / "100 to 150" -> 150 (the HIGH end: the low end would
// understate large events); "100+" / "up to 200" -> that number. The field is a
// single number, so callers keep the original text in the note unless the answer
// was a plain integer. Returns { value: number|null, exact: boolean }.
function parseGuestCount(value) {
  const v = str(value).replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (!v) return { value: null, exact: false };
  if (/^\d+$/.test(v)) return { value: Number(v), exact: true };
  const nums = (v.match(/\d+/g) || []).map(Number);
  return nums.length ? { value: Math.max(...nums), exact: false } : { value: null, exact: false };
}

// "Label: value | Label: value" (the legacy folded form) -> [{label, value}].
function parseLabeledParts(text) {
  return str(text).split('|').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(':');
    return i < 0 ? { label: '', value: p } : { label: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  });
}

// "Wix Form - Digital Mirror Homepage" -> "Digital Mirror Homepage"; '' for
// sources that aren't a named form.
function formNameFromSource(source) {
  const m = str(source).match(/^Wix Form\s*-\s*(.+)$/i);
  return m ? m[1].trim() : '';
}

// A stored `leads` row -> the lead object the push/plan code expects. New rows
// carry the shape in real columns. Rows stored before those columns existed
// have it only folded into `interest` / `notes` / `location`; for those, the
// blanks are re-derived (never overriding a real column) from that old text:
//   Wix / Meta : "Label: value | Label: value" in interest, by label
//   Google     : interest was the event-type answer, notes "Event date: ..."
//   CheckCherry: location "City, ST" -> city
function rowToLead(row) {
  const lead = {
    source: str(row.source), name: str(row.name), email: str(row.email), phone: str(row.phone),
    company: str(row.company), location: str(row.location), interest: str(row.interest),
    notes: str(row.notes), owner: str(row.owner), status: str(row.status),
    eventDate: str(row.event_date), eventType: str(row.event_type), guestCount: str(row.guest_count),
    budgetRange: str(row.budget_range), city: str(row.city), secondaryInterest: str(row.secondary_interest),
    leadType: str(row.lead_type), marketingConsent: str(row.marketing_consent), campaign: str(row.campaign),
    utmCampaign: str(row.utm_campaign), extra: str(row.extra),
  };
  const hasShape = ['eventDate', 'eventType', 'guestCount', 'budgetRange', 'city', 'secondaryInterest', 'leadType', 'marketingConsent', 'campaign']
    .some((k) => lead[k]);
  if (hasShape) return lead;

  if (/^Wix Form/i.test(lead.source) || lead.source === 'Meta Ads') {
    const META_LABELS = { services: 'interest', planning: 'eventType' };
    const folded = lead.interest;
    lead.interest = ''; // re-derived below: exactly the services answer, or blank
    parseLabeledParts(folded).forEach(({ label, value }) => {
      const key = lead.source === 'Meta Ads' ? (META_LABELS[label.toLowerCase()] || 'other') : classifyLabel(label);
      if (key === 'other' || !value) return;
      if (key === 'marketingConsent') lead.marketingConsent = lead.marketingConsent || parseConsent(value);
      else if (key === 'eventDate') lead.eventDate = lead.eventDate || toIsoDate(value);
      else lead[key] = lead[key] || value;
    });
  } else if (lead.source === 'Google Ads') {
    const m = lead.notes.match(/Event date:\s*(.+)/i);
    if (m) lead.eventDate = toIsoDate(m[1], { order: 'mdy' });
    lead.eventType = lead.interest;
    lead.interest = '';
  } else if (lead.source === 'CheckCherry' && lead.location) {
    lead.city = lead.location.split(',')[0].trim();
  }
  return lead;
}

module.exports = {
  formNameFromSource,
  rowToLead,
  SHAPE_FIELDS,
  emptyShape,
  withShape,
  classifyLabel,
  parseConsent,
  toIsoDate,
  parseGuestCount,
  parseLabeledParts,
};
