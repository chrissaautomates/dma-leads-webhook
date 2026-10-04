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

describe('backfill-ghl-fields (starts from stored rows, looks contacts up by email)', () => {
  const contacts = {
    'blank@example.com': { id: 'c1', email: 'blank@example.com', tags: [], customFields: [] },
    'full@example.com': { id: 'c2', email: 'full@example.com', tags: [], city: 'Ottawa', customFields: [{ id: FIELDS.EVENT_TYPE, value: 'Gala' }] },
    'adv@example.com': { id: 'c3', email: 'adv@example.com', tags: ['deposit'], customFields: [] },
    'dead@example.com': { id: 'c5', email: 'dead@example.com', tags: ['proposal expired'], customFields: [] },
    'consent@example.com': { id: 'c6', email: 'consent@example.com', tags: [], customFields: [{ id: FIELDS.MARKETING_CONSENT, value: 'No' }] },
  };
  const wixRow = (email, over = {}) => ({ source: 'Wix Form - Quote', email, ...over });
  const allRows = [
    wixRow('blank@example.com', { event_type: 'Gala', city: 'Toronto', guest_count: '90', interest: 'Glambot' }),
    wixRow('full@example.com', { event_type: 'Corporate', city: 'Toronto', company: 'Acme' }),
    wixRow('adv@example.com', { event_type: 'Gala' }),
    wixRow('dead@example.com', { event_type: 'Gala' }),
    wixRow('consent@example.com', { event_type: 'Gala' }),
    wixRow('ghost@example.com', { event_type: 'Gala' }), // not in GHL
    wixRow('', { event_type: 'Gala' }), // no email
    wixRow('spam@example.com', { status: 'Spam', event_type: 'Gala' }),
    wixRow('x@example.com', { name: 'TEST DMA', event_type: 'Gala' }),
    { source: 'Meta Ads', email: 'blank@example.com', event_type: 'Gala' }, // other source: not in the wix pass
  ];
  function deps(updates, lookups = []) {
    return {
      rowsForSource: (profile) => allRows.filter((r) => require('../ghl-push').profileForSource(r.source) === profile),
      findContact: async (email) => { lookups.push(email); return contacts[email] || null; },
      updateContact: async (id, body) => { updates.push({ id, body }); },
    };
  }

  test('dry run writes nothing and reports matched rows, contacts not found and still-missing counts', async () => {
    const updates = [];
    const lookups = [];
    const r = await backfillSource(WIX, deps(updates, lookups), { apply: false });
    assert.equal(updates.length, 0);
    assert.equal(r.rows, 9); // the Meta row belongs to another source
    assert.equal(r.rowsNoEmail, 1);
    assert.equal(r.rowsExcluded, 2); // spam + TEST DMA
    assert.equal(r.contacts, 6);
    assert.deepEqual(lookups.sort(), ['adv@example.com', 'blank@example.com', 'consent@example.com', 'dead@example.com', 'full@example.com', 'ghost@example.com']);
    assert.equal(r.contactsNotFound, 1);
    assert.equal(r.contactsFound, 5);
    assert.equal(r.rowsMatched, 5);
    assert.equal(r.skippedGuard, 2); // advanced + dead deal
    assert.equal(r.contactsFilled, 3); // blank, full (company only), consent
    assert.equal(r.missing.eventType, 2); // adv, dead  (blank/consent filled, full already set)
    assert.equal(r.missing.marketingConsent, 4); // never filled; consent@ already has No
    const text = formatReport([r], { apply: false });
    assert.match(text, /DRY RUN/);
    assert.match(text, /contacts NOT found in GHL:\s+1/);
    assert.match(text, /rows matched to a contact:\s+5/);
  });

  test('--apply fills only blanks, never creates, never overwrites, never writes consent', async () => {
    const updates = [];
    await backfillSource(WIX, deps(updates), { apply: true });
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.body]));
    assert.deepEqual(Object.keys(byId).sort(), ['c1', 'c2', 'c6']); // not c3 (advanced), c5 (dead), nor the missing ghost
    assert.equal(byId.c1.city, 'Toronto');
    assert.ok(byId.c1.customFields.some((f) => f.id === FIELDS.EVENT_TYPE && f.fieldValue === 'Gala'));
    assert.ok(byId.c1.customFields.some((f) => f.id === FIELDS.GUEST_COUNT && f.fieldValue === 90));
    assert.equal(byId.c2.city, undefined); // already Ottawa
    assert.equal(byId.c2.companyName, 'Acme'); // the one blank on c2
    assert.ok(!byId.c2.customFields.some((f) => f.id === FIELDS.EVENT_TYPE)); // already Gala
    updates.forEach((u) => {
      assert.equal(u.body.tags, undefined);
      [FIELDS.LEAD_SOURCE, FIELDS.LEAD_STATUS, FIELDS.LAST_ACTIVITY, FIELDS.LEAD_SCORE, FIELDS.MARKETING_CONSENT]
        .forEach((id) => assert.ok(!u.body.customFields.some((f) => f.id === id), `field ${id} not written`));
    });
  });

  test('--limit applies per source to contacts, newest first', async () => {
    const lookups = [];
    const r = await backfillSource(WIX, deps([], lookups), { limit: 2 });
    assert.equal(r.contacts, 2);
    assert.deepEqual(lookups, ['blank@example.com', 'full@example.com']);
  });

  test('several rows for one email are looked up once and merged, newest wins', async () => {
    const lookups = [];
    const rows = [wixRow('blank@example.com', { city: 'Toronto' }), wixRow('blank@example.com', { city: 'Old City', event_type: 'Gala' })];
    const d = { ...deps([], lookups), rowsForSource: () => rows };
    const updates = [];
    d.updateContact = async (id, body) => updates.push(body);
    const r = await backfillSource(WIX, d, { apply: true });
    assert.deepEqual(lookups, ['blank@example.com']);
    assert.equal(r.rowsMatched, 2);
    assert.equal(updates[0].city, 'Toronto');
    assert.ok(updates[0].customFields.some((f) => f.id === FIELDS.EVENT_TYPE && f.fieldValue === 'Gala'));
  });

  test('a GHL error on one contact is counted and does not stop the run', async () => {
    const d = deps([]);
    d.findContact = async (email) => { if (email === 'blank@example.com') throw new Error('boom'); return contacts[email] || null; };
    const r = await backfillSource(WIX, d, {});
    assert.equal(r.errors, 1);
    assert.ok(r.contacts > 1);
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
