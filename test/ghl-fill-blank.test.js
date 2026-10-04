// Guest Count / Lead Type fields, descriptive Last Activity, plan.fillBlank,
// legacy-row re-derivation and the backfill script (all with fakes — no GHL, no real DB rows).

process.env.DB_PATH = ':memory:';
process.env.GHL_FIELD_GUEST_COUNT_ID = 'guestCountFieldId';
process.env.GHL_FIELD_LEAD_TYPE_ID = 'leadTypeFieldId';
process.env.GHL_API_KEY = 'k';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildLeadPlan, resolveFillBlank } = require('../ghl-lead-plan');
const { SOURCE_PROFILES, toPlanBody } = require('../ghl-push');
const { FIELDS } = require('../ghl-canonical');
const { rowToLead } = require('../lead-shape');
const { db, upsertLead } = require('../db');
const { backfillSource, formatReport } = require('../scripts/backfill-ghl-fields');

const WIX = SOURCE_PROFILES.wix;
const val = (plan, id) => { const f = plan.customFields.find((x) => x.id === id); return f && f.fieldValue; };
const base = { email: 'a@example.com', name: 'Ana Ruiz' };

describe('Guest Count and Lead Type fields', () => {
  test('a plain guest count is written as a number', () => {
    const plan = buildLeadPlan({ ...base, guestCount: '150' }, { isNewContact: true, profile: WIX });
    assert.equal(val(plan, FIELDS.GUEST_COUNT), 150);
    assert.equal(plan.note, null);
  });

  test('a range writes its HIGH end (never understate a large event) and keeps the original text in the note', () => {
    const plan = buildLeadPlan({ ...base, guestCount: '100-150' }, { isNewContact: true, profile: WIX });
    assert.equal(val(plan, FIELDS.GUEST_COUNT), 150);
    assert.match(plan.note, /Guest Count \(submitted\): 100-150/);
  });

  test('other range spellings also take the high end', () => {
    const g = (guestCount) => val(buildLeadPlan({ ...base, guestCount }, { isNewContact: true, profile: WIX }), FIELDS.GUEST_COUNT);
    assert.equal(g('100 to 150'), 150);
    assert.equal(g('50 – 100'), 100);
    assert.equal(g('1,000-2,500'), 2500);
    assert.equal(g('200+'), 200);
    assert.equal(g('up to 300'), 300);
  });

  test('text with no number goes to the note only', () => {
    const plan = buildLeadPlan({ ...base, guestCount: 'lots' }, { isNewContact: true, profile: WIX });
    assert.equal(val(plan, FIELDS.GUEST_COUNT), undefined);
    assert.match(plan.note, /lots/);
  });

  test('lead type sets the single-select option and still tags', () => {
    const plan = buildLeadPlan({ ...base, leadType: 'event planner' }, { isNewContact: true, profile: WIX });
    assert.equal(val(plan, FIELDS.LEAD_TYPE), 'Event Planner');
    assert.ok(plan.tags.includes('planners'));
  });
});

describe('Lead Score and Last Activity', () => {
  test('Lead Score is never written', () => {
    const plan = buildLeadPlan(base, { isNewContact: true, profile: WIX });
    assert.ok(!plan.customFields.some((f) => f.id === FIELDS.LEAD_SCORE));
  });

  test('Last Activity names the form and what they asked for', () => {
    const lead = { source: 'Wix Form - Digital Mirror Homepage', ...base, interest: 'Glambot, Robotics' };
    const plan = buildLeadPlan(toPlanBody(lead), { isNewContact: true, profile: WIX });
    assert.match(val(plan, FIELDS.LAST_ACTIVITY), /^Wix Form Submission — Digital Mirror Homepage — Glambot, Robotics — \d{4}-/);
  });

  test('falls back to event type, and to the bare label when nothing was asked', () => {
    const a = buildLeadPlan({ ...base, eventType: 'Gala' }, { isNewContact: true, profile: WIX });
    assert.match(val(a, FIELDS.LAST_ACTIVITY), /^Wix Form Submission — Gala — /);
    const b = buildLeadPlan(base, { isNewContact: true, profile: WIX });
    assert.match(val(b, FIELDS.LAST_ACTIVITY), /^Wix Form Submission — \d{4}-/);
  });
});

describe('plan.fillBlank', () => {
  const lead = { ...base, city: 'Toronto', company: 'Acme', eventDate: '2027-05-30', guestCount: '80', owner: '', marketingConsent: '' };
  const plan = buildLeadPlan(lead, { isNewContact: false, profile: WIX });

  test('lists mapped values for an existing, non-advanced contact — never defaults or Last Activity', () => {
    const keys = plan.fillBlank.map((e) => e.key).sort();
    assert.deepEqual(keys, ['city', 'company', 'eventDate', 'guestCount']);
  });

  test('is empty for a new contact and for advanced / dead-deal contacts', () => {
    assert.deepEqual(buildLeadPlan(lead, { isNewContact: true, profile: WIX }).fillBlank, []);
    assert.deepEqual(buildLeadPlan(lead, { isNewContact: false, profile: WIX, context: { advancedReason: 'tag "deposit"' } }).fillBlank, []);
    assert.deepEqual(buildLeadPlan(lead, { isNewContact: false, profile: WIX, context: { reengageReason: 'Lead Status = Lost' } }).fillBlank, []);
  });

  test('resolveFillBlank fills only blanks and never overwrites', () => {
    // Plan only fills; suppress the always-written customFields so the blank check is isolated.
    const isolated = { ...plan, customFields: [], contactFields: {} };
    const contact = { city: 'Ottawa', companyName: '', customFields: [{ id: FIELDS.EVENT_DATE, value: '2026-01-01' }] };
    const fill = resolveFillBlank(isolated, contact);
    assert.deepEqual(fill.keys.sort(), ['company', 'guestCount']); // city + eventDate already set
    assert.equal(fill.contactFields.city, undefined);
    assert.deepEqual(fill.customFields, [{ id: FIELDS.GUEST_COUNT, fieldValue: 80 }]);
  });

  test('treats an empty multi-select array as blank', () => {
    const p = buildLeadPlan({ ...base, interest: 'Glambot' }, { isNewContact: false, profile: WIX });
    const isolated = { ...p, customFields: [] };
    assert.deepEqual(resolveFillBlank(isolated, { customFields: [{ id: FIELDS.INTEREST, value: [] }] }).keys, ['interest']);
    assert.deepEqual(resolveFillBlank(isolated, { customFields: [{ id: FIELDS.INTEREST, value: ['Hat Bar'] }] }).keys, []);
  });
});

describe('rowToLead — legacy rows', () => {
  test('re-derives Wix shape fields from the old folded interest string', () => {
    const lead = rowToLead({
      source: 'Wix Form - X', email: 'a@b.c',
      interest: 'What is your budget?: $5,000 - $10,000 | How many guests?: 120 | Event date: 2027-05-30 | Services: Glambot | How did you hear: Google',
    });
    assert.equal(lead.budgetRange, '$5,000 - $10,000');
    assert.equal(lead.guestCount, '120');
    assert.equal(lead.eventDate, '2027-05-30');
    assert.equal(lead.interest, 'Glambot');
  });

  test('Meta, Google and CheckCherry legacy shapes', () => {
    const meta = rowToLead({ source: 'Meta Ads', interest: 'Services: Glambot | Planning: gala | Goal: x' });
    assert.equal(meta.interest, 'Glambot');
    assert.equal(meta.eventType, 'gala');
    const g = rowToLead({ source: 'Google Ads', interest: 'Private Event', notes: 'Event date: 05/30/2027' });
    assert.equal(g.eventType, 'Private Event');
    assert.equal(g.eventDate, '2027-05-30');
    assert.equal(g.interest, '');
    assert.equal(rowToLead({ source: 'CheckCherry', location: 'Toronto, ON' }).city, 'Toronto');
  });

  test('a row with real shape columns is used as-is', () => {
    const lead = rowToLead({ source: 'Wix Form - X', interest: 'Glambot', event_type: 'Gala', city: 'Ottawa' });
    assert.equal(lead.interest, 'Glambot');
    assert.equal(lead.eventType, 'Gala');
  });
});

describe('backfill-ghl-fields', () => {
  const contacts = {
    c1: { id: 'c1', email: 'blank@example.com', tags: ['source-wix'], customFields: [] },
    c2: { id: 'c2', email: 'full@example.com', tags: ['source-wix'], city: 'Ottawa', customFields: [{ id: FIELDS.EVENT_TYPE, value: 'Gala' }] },
    c3: { id: 'c3', email: 'adv@example.com', tags: ['source-wix', 'deposit'], customFields: [] },
    c4: { id: 'c4', email: 'norow@example.com', tags: ['source-wix'], customFields: [] },
  };
  const rows = {
    'blank@example.com': [{ source: 'Wix Form - Quote', email: 'blank@example.com', event_type: 'Gala', city: 'Toronto', guest_count: '90', interest: 'Glambot' }],
    'full@example.com': [{ source: 'Wix Form - Quote', email: 'full@example.com', event_type: 'Corporate', city: 'Toronto', company: 'Acme' }],
    'adv@example.com': [{ source: 'Wix Form - Quote', email: 'adv@example.com', event_type: 'Gala' }],
  };
  function deps(updates) {
    return {
      iterateContacts: async function* () { yield* Object.values(contacts).map(({ id, email }) => ({ id, email })); },
      getContact: async (id) => contacts[id],
      updateContact: async (id, body) => { updates.push({ id, body }); },
      findRows: (email) => rows[email] || [],
    };
  }

  test('dry run writes nothing but reports the fills and what is still missing', async () => {
    const updates = [];
    const r = await backfillSource(WIX, deps(updates), { apply: false });
    assert.equal(updates.length, 0);
    assert.equal(r.scanned, 4);
    assert.equal(r.withRow, 3);
    assert.equal(r.noRow, 1);
    assert.equal(r.skippedGuard, 1); // c3 carries "deposit"
    assert.equal(r.contactsFilled, 2); // c1 fully, c2 only the blanks
    assert.equal(r.missing.eventType, 2); // c3, c4 (c1 filled, c2 already set)
    assert.equal(r.missing.city, 2); // c3, c4
    assert.match(formatReport([r], { apply: false }), /DRY RUN/);
  });

  test('--apply fills only blanks: c2 keeps its city and event type', async () => {
    const updates = [];
    await backfillSource(WIX, deps(updates), { apply: true });
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.body]));
    assert.deepEqual(Object.keys(byId).sort(), ['c1', 'c2']);
    assert.equal(byId.c1.city, 'Toronto');
    assert.ok(byId.c1.customFields.some((f) => f.id === FIELDS.EVENT_TYPE && f.fieldValue === 'Gala'));
    assert.ok(byId.c1.customFields.some((f) => f.id === FIELDS.GUEST_COUNT && f.fieldValue === 90));
    assert.equal(byId.c2.city, undefined);
    assert.equal(byId.c2.companyName, 'Acme'); // the one blank on c2
    assert.ok(!byId.c2.customFields.some((f) => f.id === FIELDS.EVENT_TYPE));
    // never sends tags / notes / lead source / status / last activity / consent default
    updates.forEach((u) => {
      assert.equal(u.body.tags, undefined);
      [FIELDS.LEAD_SOURCE, FIELDS.LEAD_STATUS, FIELDS.LAST_ACTIVITY, FIELDS.LEAD_SCORE]
        .forEach((id) => assert.ok(!u.body.customFields.some((f) => f.id === id)));
      assert.ok(!u.body.customFields.some((f) => f.id === FIELDS.MARKETING_CONSENT && f.fieldValue === 'Unknown'));
    });
  });

  test('--limit stops the scan early', async () => {
    const r = await backfillSource(WIX, deps([]), { limit: 2 });
    assert.equal(r.scanned, 2);
  });
});

describe('database round trip of the shape columns', () => {
  test('upsertLead stores every shape field; rowToLead reads them back; a re-sync never blanks them', () => {
    const lead = {
      source: 'Wix Form - Quote', name: 'Ana', email: 'Round@Example.com', interest: 'Glambot', secondaryInterest: 'Robotics',
      eventDate: '2027-05-30', eventType: 'Gala', guestCount: '150', budgetRange: '$5,000-$10,000', city: 'Toronto',
      leadType: 'Agency', marketingConsent: 'Yes', campaign: 'c1', owner: 'Richard', extra: 'How did you hear: Google',
    };
    const { id } = upsertLead(lead);
    const back = rowToLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id));
    ['interest', 'secondaryInterest', 'eventDate', 'eventType', 'guestCount', 'budgetRange', 'city', 'leadType', 'marketingConsent', 'campaign', 'owner', 'extra']
      .forEach((k) => assert.equal(back[k], lead[k], k));

    upsertLead({ source: 'Wix Form - Quote', email: 'round@example.com' }); // later sync with blanks
    assert.equal(rowToLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id)).eventType, 'Gala');
    upsertLead({ source: 'Wix Form - Quote', email: 'round@example.com', eventType: 'Corporate' }); // non-blank updates
    assert.equal(rowToLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id)).eventType, 'Corporate');
  });
});
