// A–E: repeat-inquiry tag (remove -> add), no overwrite of score/status/owner and fill-only /
// newer-wins on existing contacts, form tags, CheckCherry "proposal sent" tagging, and
// marketing consent exactly "Yes". GHL is a route-based fetch stub; the DB is :memory:.

process.env.DB_PATH = ':memory:';
process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';
process.env.GHL_FIELD_GUEST_COUNT_ID = 'guestCountFieldId';
process.env.GHL_FIELD_LEAD_TYPE_ID = 'leadTypeFieldId';

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { db, upsertLead, getProposalTagOutcome } = require('../db');
const push = require('../ghl-push');
const ghlClient = require('../ghl-client');
const config = require('../config');
const { buildLeadPlan, resolveFillBlank } = require('../ghl-lead-plan');
const { FIELDS, FIELD_OPTIONS, TAGS } = require('../ghl-canonical');

// ---- stub -----------------------------------------------------------------
let calls; let contacts; let byEmail; let failRemoveWith;
const realFetch = global.fetch;
function reset() { calls = []; contacts = {}; byEmail = {}; failRemoveWith = null; }
function addContact(email, c) { const id = `c-${Object.keys(contacts).length + 1}`; contacts[id] = { id, email, tags: [], customFields: [], ...c }; byEmail[email.toLowerCase()] = id; return id; }
async function mockFetch(url, options = {}) {
  const method = (options && options.method) || 'GET';
  const u = String(url);
  const rec = { method, url: u, body: options && options.body ? JSON.parse(options.body) : undefined };
  calls.push(rec);
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body || {}), json: async () => body || {} });
  if (u.includes('/contacts/search/duplicate')) {
    const email = (new URL(u).searchParams.get('email') || '').toLowerCase();
    return byEmail[email] ? reply(200, { contact: { id: byEmail[email] } }) : reply(404, {});
  }
  const m = u.match(/\/contacts\/([^/]+)(\/tags|\/notes)?$/);
  if (method === 'GET' && m && !m[2]) return contacts[m[1]] ? reply(200, { contact: contacts[m[1]] }) : reply(404, {});
  if (method === 'POST' && u.endsWith('/contacts/')) return reply(200, { contact: { id: 'new-contact' } });
  if (method === 'PUT') return reply(200, { contact: { id: m && m[1] } });
  if (method === 'DELETE' && m && m[2] === '/tags') return failRemoveWith ? reply(failRemoveWith, {}) : reply(200, {});
  if (method === 'POST' && m && m[2] === '/tags') return reply(200, {});
  if (method === 'POST' && m && m[2] === '/notes') return reply(200, {});
  throw new Error(`unmocked GHL call: ${method} ${u}`);
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const put = () => calls.find((c) => c.method === 'PUT');
const post = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/'));
const tagPosts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/tags')).flatMap((c) => c.body.tags);
const field = (body, id) => { const f = (body.customFields || []).find((x) => x.id === id); return f ? f.fieldValue : undefined; };

let logs = [];
const realLog = console.log;
before(() => { global.fetch = mockFetch; console.log = (...a) => logs.push(a.join(' ')); });
after(() => { global.fetch = realFetch; console.log = realLog; });

const LIVE = { GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' };
function setEnv(env) {
  ['GHL_PUSH_LIVE', 'GHL_PUSH_DISABLED', 'GHL_PUSH_CUTOFF_DATE', 'GHL_CHECKCHERRY_SETTLE_MINUTES'].forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
}
beforeEach(() => { reset(); logs = []; setEnv({}); delete process.env.CHECKCHERRY_API_KEY; db.exec('DELETE FROM proposal_emails; DELETE FROM sync_state; DELETE FROM cc_proposal_tags;'); });

let seq = 0;
const newLead = (over = {}) => { seq += 1; return { source: 'Meta Ads', name: `Jane ${seq}`, email: `rep${seq}@example.com`, interest: 'Glambot', dateReceived: '2026-10-05', ...over }; };
const run = async (lead) => push.pushAfterUpsert(lead, upsertLead(lead));

// ============================ A. repeat inquiry ==============================
describe('A. repeat-inquiry: existing contact -> remove then add, never new-lead again', () => {
  test('existing contact without the tag: repeat-inquiry added, no DELETE, no new-lead', async () => {
    setEnv(LIVE);
    const lead = newLead(); addContact(lead.email, { tags: ['source-meta'] });
    await run(lead);
    assert.ok(tagPosts().includes('repeat-inquiry'));
    assert.ok(!tagPosts().includes('new-lead'));
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  });

  test('existing contact already carrying repeat-inquiry: DELETE first, THEN add — so Tag Added fires again', async () => {
    setEnv(LIVE);
    const lead = newLead(); addContact(lead.email, { tags: ['repeat-inquiry'] });
    await run(lead);
    const del = calls.findIndex((c) => c.method === 'DELETE');
    const add = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/tags'));
    assert.ok(del >= 0 && add > del, `remove (${del}) must precede add (${add})`);
    assert.deepEqual(calls[del].body, { tags: ['repeat-inquiry'] });
    assert.ok(calls[add].body.tags.includes('repeat-inquiry'));
  });

  test('every push for an existing contact removes and re-adds it (so Tag Added fires each time)', async () => {
    setEnv(LIVE);
    const lead = newLead();
    const id = addContact(lead.email, { tags: [] });
    for (let i = 0; i < 3; i++) {
      calls.length = 0;
      await push.pushLeadToGhl(lead, { profile: push.SOURCE_PROFILES.meta, dryRun: false });
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, i === 0 ? 0 : 1, `push #${i + 1}`);
      assert.ok(tagPosts().includes('repeat-inquiry'));
      contacts[id].tags = ['repeat-inquiry']; // GHL now has the tag from the previous push
    }
  });

  test('KNOWN LIMIT (documented, not changed here): a row is pushed at most once, so a 2nd submission from the SAME email updates the stored row but does not push again', async () => {
    setEnv(LIVE);
    const lead = newLead();
    addContact(lead.email, { tags: [] });
    assert.equal(await run(lead), 'pushed');
    calls.length = 0;
    assert.equal(await push.pushAfterUpsert(lead, upsertLead({ ...lead, interest: 'Robotics' })), 'not-pending');
    assert.equal(calls.length, 0);
  });

  test('new-lead is NOT added to an existing contact (with or without the tag), only on creation', async () => {
    setEnv(LIVE);
    const a = newLead(); addContact(a.email, { tags: [] });
    await run(a);
    assert.ok(!tagPosts().includes('new-lead'));
    reset();
    const b = newLead(); addContact(b.email, { tags: ['new-lead'] });
    await run(b);
    assert.ok(!tagPosts().includes('new-lead'), 'not again');
    reset();
    const c = newLead();
    await run(c);
    assert.ok(tagPosts().includes('new-lead'), 'a brand-new contact still gets it');
    assert.ok(!tagPosts().includes('repeat-inquiry'), 'and is not a repeat');
  });

  test('advanced and dead-deal existing contacts also get the remove->add event tag (and nothing else)', async () => {
    setEnv(LIVE);
    const a = newLead(); addContact(a.email, { tags: ['deposit', 'repeat-inquiry'] });
    await run(a);
    assert.deepEqual(calls.find((c) => c.method === 'DELETE').body.tags, ['repeat-inquiry']);
    assert.deepEqual(tagPosts(), ['repeat-inquiry']);
    reset();
    const d = newLead(); addContact(d.email, { tags: ['proposal expired'] });
    await run(d);
    assert.deepEqual(tagPosts().sort(), ['newsletter-reengagement', 'repeat-inquiry']);
  });

  test('dry run: no DELETE, no POST; the log shows remove-then-add', async () => {
    const lead = newLead(); addContact(lead.email, { tags: ['repeat-inquiry'] });
    await run(lead);
    assert.deepEqual(writes(), []);
    assert.match(logs.find((l) => l.includes('WOULD UPDATE')), /remove-then-add=\[repeat-inquiry\]/);
  });

  test('ghl-client removeTags: 404 is success, other errors throw, empty list is a no-op', async () => {
    await ghlClient.removeTags('abc', []);
    assert.equal(calls.length, 0);
    const id = addContact('x@example.com', {});
    failRemoveWith = 404;
    await ghlClient.removeTags(id, ['repeat-inquiry']);
    failRemoveWith = 500;
    await assert.rejects(ghlClient.removeTags(id, ['repeat-inquiry']), /remove-tags HTTP 500/);
  });
});

// ================== B. never overwrite score/status/owner; fill-only ===========
describe('B. existing contacts: score/status/owner untouched; other fields fill-only; event date + guests newer-wins', () => {
  const contactWith = (cf, extra = {}) => ({ tags: [], customFields: cf, ...extra });

  test('Lead Score, Lead Status and Owner are never in the update, whatever they hold', async () => {
    setEnv(LIVE);
    const lead = newLead({ owner: 'Richard' }); FIELD_OPTIONS.OWNER.push('Richard');
    try {
      for (const cf of [
        [{ id: FIELDS.LEAD_STATUS, value: 'Hot' }, { id: FIELDS.LEAD_SCORE, value: 25 }, { id: FIELDS.OWNER, value: 'Sonia' }],
        [{ id: FIELDS.LEAD_STATUS, value: 'New' }],
        [],
      ]) {
        reset();
        addContact(lead.email, contactWith(cf));
        await push.pushAfterUpsert(lead, { action: 'updated', id: upsertLead(lead).id });
        const body = put() ? put().body : { customFields: [] };
        assert.equal(field(body, FIELDS.LEAD_STATUS), undefined);
        assert.equal(field(body, FIELDS.LEAD_SCORE), undefined);
        if (cf.some((f) => f.id === FIELDS.OWNER)) assert.equal(field(body, FIELDS.OWNER), undefined, 'existing owner kept');
        db.exec(`UPDATE leads SET ghl_pushed = NULL WHERE email = '${lead.email}'`);
      }
    } finally { FIELD_OPTIONS.OWNER.length = 0; }
  });

  test('other populated fields are not overwritten; blank ones are filled', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventType: 'Corporate', budgetRange: '$5,000-$10,000', campaign: 'new-campaign', city: 'Toronto', company: 'NewCo', phone: '5550000' });
    addContact(lead.email, contactWith(
      [{ id: FIELDS.EVENT_TYPE, value: 'Gala' }, { id: FIELDS.CAMPAIGN, value: 'old-campaign' }],
      { city: 'Ottawa', phone: '5551111', firstName: 'Kept', lastName: 'Name' }
    ));
    await run(lead);
    const body = put().body;
    assert.equal(field(body, FIELDS.EVENT_TYPE), undefined, 'event type kept');
    assert.equal(field(body, FIELDS.CAMPAIGN), undefined, 'campaign kept');
    assert.equal(field(body, FIELDS.BUDGET_RANGE), '$5,000-$10,000', 'blank budget filled');
    assert.equal(body.city, undefined);
    assert.equal(body.phone, undefined);
    assert.equal(body.firstName, undefined);
    assert.equal(body.lastName, undefined);
    assert.equal(body.companyName, 'NewCo', 'blank company filled');
    assert.equal(body.email, undefined);
  });

  test('event date: a LATER new date replaces the one on file; guest count follows it', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventDate: '2027-05-30', guestCount: '150' });
    addContact(lead.email, contactWith([{ id: FIELDS.EVENT_DATE, value: '2026-11-01' }, { id: FIELDS.GUEST_COUNT, value: 40 }]));
    await run(lead);
    assert.equal(field(put().body, FIELDS.EVENT_DATE), '2027-05-30');
    assert.equal(field(put().body, FIELDS.GUEST_COUNT), 150);
  });

  test('event date: an EARLIER or equal new date does not replace a later one; guest count kept (older event)', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventDate: '2026-12-01', guestCount: '500' });
    addContact(lead.email, contactWith([{ id: FIELDS.EVENT_DATE, value: '2027-05-30' }, { id: FIELDS.GUEST_COUNT, value: 40 }]));
    await run(lead);
    assert.equal(field(put().body, FIELDS.EVENT_DATE), undefined);
    assert.equal(field(put().body, FIELDS.GUEST_COUNT), undefined);
  });

  test('same event date again: date unchanged, the guest count is updated (not an older event)', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventDate: '2027-05-30', guestCount: '200' });
    addContact(lead.email, contactWith([{ id: FIELDS.EVENT_DATE, value: '2027-05-30' }, { id: FIELDS.GUEST_COUNT, value: 120 }]));
    await run(lead);
    assert.equal(field(put().body, FIELDS.EVENT_DATE), undefined);
    assert.equal(field(put().body, FIELDS.GUEST_COUNT), 200);
  });

  test('no new event date: guest count only fills an empty field', async () => {
    setEnv(LIVE);
    const a = newLead({ guestCount: '90' });
    addContact(a.email, contactWith([{ id: FIELDS.GUEST_COUNT, value: 300 }]));
    await run(a);
    assert.equal(field(put().body, FIELDS.GUEST_COUNT), undefined);
    reset();
    const b = newLead({ guestCount: '90' });
    addContact(b.email, contactWith([]));
    await run(b);
    assert.equal(field(put().body, FIELDS.GUEST_COUNT), 90);
  });

  test('existing event date as epoch milliseconds or ISO datetime is understood; an unreadable one is left alone', () => {
    const plan = buildLeadPlan({ email: 'a@example.com', eventDate: '2027-05-30' }, { isNewContact: false, profile: push.SOURCE_PROFILES.meta });
    const keys = (v) => resolveFillBlank({ ...plan, customFields: [] }, { customFields: [{ id: FIELDS.EVENT_DATE, value: v }] }).keys.filter((k) => k === 'eventDate');
    assert.deepEqual(keys(Date.UTC(2026, 0, 1)), ['eventDate']); // epoch ms, older
    assert.deepEqual(keys('2026-01-01T00:00:00.000Z'), ['eventDate']);
    assert.deepEqual(keys(Date.UTC(2028, 0, 1)), []); // later on file
    assert.deepEqual(keys('whenever'), []); // unreadable: never overwritten
  });

  test('the backfill never overwrites (blankOnly disables newer-wins)', () => {
    const plan = buildLeadPlan({ email: 'a@example.com', eventDate: '2027-05-30', guestCount: '10' }, { isNewContact: false, profile: push.SOURCE_PROFILES.meta });
    const fill = resolveFillBlank(plan, { customFields: [{ id: FIELDS.EVENT_DATE, value: '2026-01-01' }] }, { standalone: true, blankOnly: true });
    assert.ok(!fill.keys.includes('eventDate'));
  });

  test('a brand-new contact still gets Lead Source and Status "New" (defaults are creation-only)', async () => {
    setEnv(LIVE);
    const lead = newLead();
    await run(lead);
    assert.equal(field(post().body, FIELDS.LEAD_STATUS), 'New');
    assert.equal(field(post().body, FIELDS.LEAD_SCORE), undefined);
  });
});

// ============================ C. form tags ==================================
describe('C. proposal-requested / quiz-completed from the source form', () => {
  const QUOTE = 'Wix Form - Check Availability.  Get a Quote.  Secure Your Date.';
  const tagsFor = async (over, existing) => {
    setEnv(LIVE);
    const lead = newLead({ source: 'Wix Form - x', ...over });
    if (existing) addContact(lead.email, existing);
    await run(lead);
    return tagPosts();
  };

  test('the quote-request form gets proposal-requested', async () => {
    assert.ok((await tagsFor({ source: QUOTE })).includes('proposal-requested'));
  });
  test('a proposal form and a quiz form: proposal-requested / quiz-completed', async () => {
    assert.ok((await tagsFor({ source: 'Wix Form - Request a Proposal' })).includes('proposal-requested'));
    reset();
    const t = await tagsFor({ source: 'Wix Form - Activation Quiz' });
    assert.ok(t.includes('quiz-completed'));
    assert.ok(!t.includes('proposal-requested'));
  });
  test('ordinary forms get neither', async () => {
    for (const source of ['Wix Form - Contact Us Form', 'Wix Form - Digital Mirror Homepage', 'Wix Form - Service Inquiry', 'Meta Ads']) {
      reset();
      const t = await tagsFor({ source });
      assert.ok(!t.includes('proposal-requested') && !t.includes('quiz-completed'), source);
    }
  });
  test('applies to existing contacts too, including advanced ones', async () => {
    assert.ok((await tagsFor({ source: QUOTE }, { tags: [] })).includes('proposal-requested'));
    reset();
    assert.ok((await tagsFor({ source: QUOTE }, { tags: ['deposit'] })).includes('proposal-requested'));
  });
  test('config rules: matching is by form name', () => {
    assert.deepEqual(config.formTags('Check Availability. Get a Quote. Secure Your Date.'), ['proposal-requested']);
    assert.deepEqual(config.formTags('Brand Activation Quiz'), ['quiz-completed']);
    assert.deepEqual(config.formTags('Quote Quiz'), ['proposal-requested', 'quiz-completed']);
    assert.deepEqual(config.formTags('Contact Us Form'), []);
    assert.deepEqual(config.formTags(''), []);
  });
});

// ================== D. CheckCherry proposal sent -> cc-proposal-sent =========
describe('D. CheckCherry proposal sent for an EXISTING contact -> cc-proposal-sent', () => {
  const ev = (over = {}) => ({
    id: String(1000 + (seq += 1)),
    attributes: { status: 'awaiting_signature', created_at: '2026-10-03T10:00:00Z', customer_emails: 'client@example.com, colleague@example.com', customer_names: 'Cy Client', ...over },
  });

  test('live: an existing contact without the tag is tagged (primary email only), recorded once', async () => {
    setEnv(LIVE);
    addContact('client@example.com', { tags: ['source-wix'] });
    const colleague = addContact('colleague@example.com', { tags: [] });
    const e = ev();
    const r = await push.tagProposalSentContacts([e]);
    assert.equal(r.tagged, 1);
    assert.deepEqual(tagPosts(), ['cc-proposal-sent']);
    assert.ok(calls.some((c) => c.url.endsWith('/tags') && c.url.includes('/c-1/')), 'tagged the primary contact');
    assert.ok(!calls.some((c) => c.url.includes(`/${colleague}/`)), 'colleague address untouched');
    assert.equal(getProposalTagOutcome(e.id), 'tagged');
    calls.length = 0;
    await push.tagProposalSentContacts([e]);
    assert.equal(calls.length, 0, 'not re-processed on the next 15-minute cycle');
  });

  test('never creates a contact: no existing contact -> no write at all', async () => {
    setEnv(LIVE);
    await push.tagProposalSentContacts([ev()]);
    assert.deepEqual(writes(), []);
  });

  test('already tagged (any case): not added again, recorded', async () => {
    setEnv(LIVE);
    addContact('client@example.com', { tags: ['CC-Proposal-Sent'] });
    const e = ev();
    await push.tagProposalSentContacts([e]);
    assert.deepEqual(writes(), []);
    assert.equal(getProposalTagOutcome(e.id), 'already-tagged');
  });

  test('only proposal-stage events count: confirmed / canceled / archived / postponed are skipped', async () => {
    setEnv(LIVE);
    addContact('client@example.com', {});
    await push.tagProposalSentContacts([
      ev({ status: 'confirmed' }), ev({ canceled: true }), ev({ archived: true }), ev({ postponed: true }), ev({ status: 'something_new' }),
    ]);
    assert.equal(calls.length, 0);
    for (const status of ['proposal_date_open', 'proposal_date_reserved', 'awaiting_signature']) {
      reset(); addContact('client@example.com', {});
      assert.equal((await push.tagProposalSentContacts([ev({ status })])).tagged, 1, status);
    }
  });

  test('live: events created before the cutoff are never tagged (back catalog is safe)', async () => {
    setEnv(LIVE);
    addContact('client@example.com', {});
    await push.tagProposalSentContacts([ev({ created_at: '2026-09-15T10:00:00Z' })]);
    assert.equal(calls.length, 0);
  });

  test('dry run: logs WOULD TAG once, sends and records nothing', async () => {
    const now = new Date('2026-10-05T00:00:00Z');
    addContact('client@example.com', {});
    const e = ev();
    await push.tagProposalSentContacts([e], { now });
    assert.deepEqual(writes(), []);
    assert.ok(logs.some((l) => /DRY-RUN\] WOULD TAG existing contact .* cc-proposal-sent/.test(l)));
    assert.equal(getProposalTagOutcome(e.id), null);
    const lookups = calls.length;
    await push.tagProposalSentContacts([e], { now });
    assert.equal(calls.length, lookups, 'no repeat lookups for the same event');
  });

  test('dry run only looks at recent events (no cutoff => 14-day window)', async () => {
    addContact('client@example.com', {});
    await push.tagProposalSentContacts([ev({ created_at: '2026-08-01T00:00:00Z' })], { now: new Date('2026-10-05T00:00:00Z') });
    assert.equal(calls.length, 0);
  });

  test('mode off (kill switch / live without cutoff): nothing happens', async () => {
    addContact('client@example.com', {});
    for (const env of [{ GHL_PUSH_DISABLED: 'true', ...LIVE }, { GHL_PUSH_LIVE: 'true' }]) {
      setEnv(env);
      const r = await push.tagProposalSentContacts([ev()]);
      assert.equal(r.mode, 'off');
      assert.equal(calls.length, 0);
    }
  });

  test('test / internal addresses are skipped', async () => {
    setEnv(LIVE);
    addContact('test.dma@example.com', {});
    await push.tagProposalSentContacts([ev({ customer_emails: 'test.dma@example.com' })]);
    assert.equal(calls.length, 0);
  });

  test('a contact that is not in GHL yet is retried, then given up on after 3 days', async () => {
    setEnv(LIVE);
    const young = ev({ created_at: '2026-10-04T10:00:00Z' });
    await push.tagProposalSentContacts([young], { now: new Date('2026-10-05T00:00:00Z') });
    assert.equal(getProposalTagOutcome(young.id), null, 'retried next cycle');
    const old = ev({ created_at: '2026-10-01T10:00:00Z' });
    await push.tagProposalSentContacts([old], { now: new Date('2026-10-09T00:00:00Z') });
    assert.equal(getProposalTagOutcome(old.id), 'no-contact');
  });

  test('cc-proposal-sent makes the contact "advanced": the next lead push never gives it new-lead and sends only event tags', async () => {
    setEnv(LIVE);
    const lead = newLead();
    addContact(lead.email, { tags: ['cc-proposal-sent'] });
    await run(lead);
    assert.ok(!tagPosts().includes('new-lead'));
    assert.deepEqual(tagPosts(), ['repeat-inquiry']);
  });
});

// ================== E. marketing consent exactly "Yes" ======================
describe('E. marketing consent: exactly "Yes" when given, empty otherwise', () => {
  test('a consenting new lead is written as the exact string "Yes"', async () => {
    setEnv(LIVE);
    for (const answer of ['yes', 'YES', 'Yes, please', 'true', 'i agree']) {
      reset();
      const lead = newLead({ marketingConsent: answer });
      await run(lead);
      assert.strictEqual(field(post().body, FIELDS.MARKETING_CONSENT), 'Yes', answer);
    }
  });

  test('no answer, "No", "No thanks", unclear: nothing is written (no "No", no "Unknown")', async () => {
    setEnv(LIVE);
    for (const answer of ['', undefined, 'no', 'No thanks', 'false', 'not sure']) {
      reset();
      const lead = newLead({ marketingConsent: answer });
      await run(lead);
      assert.strictEqual(field(post().body, FIELDS.MARKETING_CONSENT), undefined, String(answer));
      assert.ok(!JSON.stringify(post().body).includes('Unknown'));
    }
  });

  test('existing contact: empty or Unknown + consent -> "Yes"; existing Yes/No is never changed', async () => {
    setEnv(LIVE);
    for (const [existing, expected] of [[[], 'Yes'], [[{ id: FIELDS.MARKETING_CONSENT, value: 'Unknown' }], 'Yes'], [[{ id: FIELDS.MARKETING_CONSENT, value: 'No' }], undefined], [[{ id: FIELDS.MARKETING_CONSENT, value: 'Yes' }], undefined]]) {
      reset();
      const lead = newLead({ marketingConsent: 'yes' });
      addContact(lead.email, { customFields: existing });
      await run(lead);
      assert.strictEqual(field(put().body, FIELDS.MARKETING_CONSENT), expected, JSON.stringify(existing));
    }
  });

  test('existing Yes/No with no answer in the new lead: consent is not touched', async () => {
    setEnv(LIVE);
    for (const value of ['Yes', 'No']) {
      reset();
      const lead = newLead();
      addContact(lead.email, { customFields: [{ id: FIELDS.MARKETING_CONSENT, value }] });
      await run(lead);
      assert.strictEqual(field(put().body, FIELDS.MARKETING_CONSENT), undefined);
    }
  });

  test('the live DMA Marketing Consent picklist really has the exact option "Yes"', () => {
    assert.ok(FIELD_OPTIONS.MARKETING_CONSENT.includes('Yes'));
  });
});
