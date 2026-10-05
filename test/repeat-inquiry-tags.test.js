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

// ================= 1. per-submission dedupe (submission id, not email) =========
describe('1. every NEW submission reaches GHL; email stays the contact key', () => {
  const { hasSubmission } = require('../db');
  const sub = (lead, n, over = {}) => ({ ...lead, submissionId: `${lead.source === 'Meta Ads' ? 'meta' : 'wix'}:sub-${n}`, ...over });
  const pushIt = (lead) => push.pushAfterUpsert(lead, upsertLead(lead));

  test('2nd and 3rd submissions from the same person each push once, as repeat inquiries; re-reading them never re-pushes', async () => {
    setEnv(LIVE);
    const base = newLead();
    const id = addContact(base.email, { tags: [] });
    assert.equal(await pushIt(sub(base, 1)), 'pushed');
    contacts[id].tags = ['repeat-inquiry'];
    calls.length = 0;
    assert.equal(await pushIt(sub(base, 2, { interest: 'Robotics' })), 'pushed-repeat');
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1, 'repeat-inquiry removed then re-added');
    assert.ok(tagPosts().includes('repeat-inquiry'));
    assert.ok(!tagPosts().includes('new-lead'));
    assert.equal(await pushIt(sub(base, 3)), 'pushed-repeat');
    calls.length = 0;
    for (const n of [1, 2, 3]) assert.equal(await pushIt(sub(base, n)), 'not-pending', `sync cycle re-reads submission ${n}`);
    assert.equal(calls.length, 0);
    assert.ok(hasSubmission('meta:sub-1') && hasSubmission('meta:sub-2') && hasSubmission('meta:sub-3'));
  });

  test('a submission without an id behaves as before (a pushed row stays done)', async () => {
    setEnv(LIVE);
    const lead = newLead();
    addContact(lead.email, {});
    assert.equal(await pushIt(lead), 'pushed');
    assert.equal(await pushIt({ ...lead, interest: 'Robotics' }), 'not-pending');
  });

  test('a failed push is not recorded, so the same submission is retried', async () => {
    setEnv(LIVE);
    const base = newLead();
    addContact(base.email, {});
    assert.equal(await pushIt(sub(base, 10)), 'pushed');
    const realF = global.fetch; global.fetch = async () => ({ ok: false, status: 500, text: async () => '{}', json: async () => ({}) });
    try { assert.equal(await pushIt(sub(base, 11)), 'error'); } finally { global.fetch = realF; }
    assert.equal(hasSubmission('meta:sub-11'), false);
    assert.equal(await pushIt(sub(base, 11)), 'pushed-repeat');
  });

  test('a LEGACY row: its own back-catalog submission is never pushed, a strictly newer one is', async () => {
    setEnv(LIVE);
    const base = newLead({ dateReceived: '2026-09-01' });
    addContact(base.email, {});
    const { id } = upsertLead(sub(base, 20));
    db.exec(`UPDATE leads SET ghl_pushed = 'legacy' WHERE id = ${id}`);
    assert.equal(await pushIt(sub(base, 20)), 'not-pending', 'old submission');
    assert.equal(await pushIt(sub(base, 21, { dateReceived: '2026-09-01' })), 'not-pending', 'same day as the legacy row');
    calls.length = 0;
    assert.equal(await pushIt(sub(base, 22, { dateReceived: '2026-10-05' })), 'pushed-repeat');
    assert.ok(tagPosts().includes('repeat-inquiry'));
  });

  test('live: a submission dated before the cutoff never pushes; excluded rows never repeat-push', async () => {
    setEnv(LIVE);
    const base = newLead({ dateReceived: '2026-10-02' });
    addContact(base.email, {});
    assert.equal(await pushIt(sub(base, 30)), 'pushed');
    calls.length = 0;
    assert.equal(await pushIt(sub(base, 31, { dateReceived: '2026-09-20' })), 'not-pending');
    const spam = newLead({ status: 'Spam' });
    assert.equal(await pushIt(sub(spam, 32)), 'excluded_spam');
    assert.equal(await pushIt(sub(spam, 33, { dateReceived: '2026-10-06' })), 'not-pending');
    assert.equal(calls.length, 0);
  });

  test('test/internal and BARR submissions never repeat-push', async () => {
    setEnv(LIVE);
    const base = newLead();
    addContact(base.email, {});
    await pushIt(sub(base, 40));
    calls.length = 0;
    const r = await pushIt(sub({ ...base, name: 'TEST DMA' }, 41, { dateReceived: '2026-10-06' }));
    assert.equal(r, 'excluded_test');
    assert.deepEqual(writes(), []);
  });

  test('dry run: WOULD ... [repeat submission] once per submission, nothing written or recorded', async () => {
    const base = newLead();
    const { id } = upsertLead(sub(base, 50));
    db.exec(`UPDATE leads SET ghl_pushed = 'pushed' WHERE id = ${id}`); // as if pushed earlier
    addContact(base.email, { tags: ['repeat-inquiry'] });
    assert.equal(await pushIt(sub(base, 51)), 'dry-run');
    assert.deepEqual(writes(), []);
    assert.ok(logs.some((l) => /WOULD UPDATE.*\[repeat submission\]/.test(l)));
    assert.equal(hasSubmission('meta:sub-51'), false);
    const n = calls.length;
    assert.equal(await pushIt(sub(base, 51)), 'dry-run-seen');
    assert.equal(calls.length, n);
  });

  test('every source mapper sets its own submission id', () => {
    const sync = require('../sync');
    const { mapGoogleAdsLead } = require('../server');
    const form = { id: 'f1', fields: [{ target: 'em', view: { label: 'Email', fieldType: 'CONTACTS_EMAIL' } }] };
    const wix = sync.mapWixFormSubmission({ id: 'aaaa-bbbb', submissions: { em: 'a@b.c' }, createdDate: '2026-10-01T00:00:00Z' }, sync.buildFieldMetaMap(form), sync.taggedCategoriesInForm(form), 'Wix Form - X');
    assert.equal(wix.submissionId, 'wix:aaaa-bbbb');
    assert.equal(sync.mapMetaAdsRow({ id: 'l:123', email: 'a@b.c' }).submissionId, 'meta:l:123');
    assert.equal(mapGoogleAdsLead([{ column_id: 'EMAIL', string_value: 'a@b.c' }], { lead_id: 'gl-9' }).submissionId, 'google:gl-9');
    assert.equal(sync.mapCheckCherryLead({ id: 77, attributes: { email: 'a@b.c' } }).submissionId, 'checkcherry:77');
    assert.equal(sync.mapMetaAdsRow({ id: '', email: 'a@b.c' }).submissionId, '');
  });
});

// ============ 2. form tags: remove then add (like repeat-inquiry) ============
describe('2. proposal-requested / quiz-completed are removed then re-added so they fire every time', () => {
  const QUOTE = 'Wix Form - Check Availability.  Get a Quote.  Secure Your Date.';
  test('an existing contact that already has proposal-requested: DELETE (both event tags it has) precedes the add', async () => {
    setEnv(LIVE);
    const lead = newLead({ source: QUOTE });
    addContact(lead.email, { tags: ['proposal-requested', 'repeat-inquiry', 'unrelated'] });
    await run(lead);
    const del = calls.findIndex((c) => c.method === 'DELETE');
    const add = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/tags'));
    assert.ok(del >= 0 && add > del);
    assert.deepEqual([...calls[del].body.tags].sort(), ['proposal-requested', 'repeat-inquiry']);
    assert.ok(calls[add].body.tags.includes('proposal-requested') && calls[add].body.tags.includes('repeat-inquiry'));
  });
  test('only tags the contact actually has are removed; a contact without them just gets them added', async () => {
    setEnv(LIVE);
    const lead = newLead({ source: QUOTE });
    addContact(lead.email, { tags: ['repeat-inquiry'] });
    await run(lead);
    assert.deepEqual(calls.find((c) => c.method === 'DELETE').body.tags, ['repeat-inquiry']);
    assert.ok(tagPosts().includes('proposal-requested'));
  });
  test('quiz-completed gets the same treatment (config pattern), advanced contacts included', async () => {
    setEnv(LIVE);
    const lead = newLead({ source: 'Wix Form - Activation Quiz' });
    addContact(lead.email, { tags: ['quiz-completed', 'deposit'] });
    await run(lead);
    assert.ok(calls.find((c) => c.method === 'DELETE').body.tags.includes('quiz-completed'));
    assert.ok(tagPosts().includes('quiz-completed'));
  });
  test('a NEW contact: nothing to remove', async () => {
    setEnv(LIVE);
    await run(newLead({ source: QUOTE }));
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
    assert.ok(tagPosts().includes('proposal-requested'));
  });
  test('dry run shows remove-then-add for both', async () => {
    const lead = newLead({ source: QUOTE });
    addContact(lead.email, { tags: ['proposal-requested', 'repeat-inquiry'] });
    await run(lead);
    assert.match(logs.find((l) => l.includes('WOULD UPDATE')), /remove-then-add=\[repeat-inquiry, proposal-requested\]/);
    assert.deepEqual(writes(), []);
  });
});

// ============ 7. implied consent for Canadian phone numbers ===================
describe('7. Canadian phone -> Marketing Consent "Yes" (implied), tagged consent-implied-inquiry', () => {
  const CA = '+1 416 204 1234'; const CA_LOCAL = '416-204-1234'; const US = '+1 212 555 1234';
  const consentOf = (body) => field(body, FIELDS.MARKETING_CONSENT);
  const created = async (over) => { reset(); setEnv(LIVE); await run(newLead(over)); return post().body; };
  const existingRun = async (cf, over, contactExtra = {}) => { reset(); setEnv(LIVE); const lead = newLead(over); addContact(lead.email, { customFields: cf, ...contactExtra }); await run(lead); return put() ? put().body : { customFields: [] }; };

  test('Canadian number, consent empty (new contact) -> "Yes" + consent-implied-inquiry', async () => {
    assert.strictEqual(consentOf(await created({ phone: CA })), 'Yes');
    assert.ok(tagPosts().includes('consent-implied-inquiry'));
  });
  test('Canadian local format (no +1) is read as Canadian too', async () => {
    assert.strictEqual(consentOf(await created({ phone: CA_LOCAL })), 'Yes');
  });
  test('existing contact: empty -> Yes and "Unknown" -> Yes, both tagged', async () => {
    for (const cf of [[], [{ id: FIELDS.MARKETING_CONSENT, value: 'Unknown' }]]) {
      assert.strictEqual(consentOf(await existingRun(cf, { phone: CA })), 'Yes', JSON.stringify(cf));
      assert.ok(tagPosts().includes('consent-implied-inquiry'));
    }
  });
  test('Canadian number with an existing "No": stays No, no write, no tag', async () => {
    const body = await existingRun([{ id: FIELDS.MARKETING_CONSENT, value: 'No' }], { phone: CA });
    assert.strictEqual(consentOf(body), undefined);
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('Canadian number with an existing "Yes": untouched, no implied tag', async () => {
    const body = await existingRun([{ id: FIELDS.MARKETING_CONSENT, value: 'Yes' }], { phone: CA });
    assert.strictEqual(consentOf(body), undefined);
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('US number, consent empty: stays empty, no tag', async () => {
    assert.strictEqual(consentOf(await created({ phone: US })), undefined);
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
    assert.strictEqual(consentOf(await existingRun([], { phone: US })), undefined);
  });
  test('US number with an EXPLICIT Yes -> "Yes", and no implied tag (it is explicit)', async () => {
    assert.strictEqual(consentOf(await created({ phone: US, marketingConsent: 'Yes' })), 'Yes');
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('Canadian number with an explicit Yes: Yes, but not tagged as implied', async () => {
    assert.strictEqual(consentOf(await created({ phone: CA, marketingConsent: 'yes' })), 'Yes');
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('Canadian number but the form says an explicit No: no implied consent', async () => {
    assert.strictEqual(consentOf(await created({ phone: CA, marketingConsent: 'No thanks' })), undefined);
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('no phone: left as is (new and existing)', async () => {
    assert.strictEqual(consentOf(await created({})), undefined);
    assert.strictEqual(consentOf(await existingRun([], {})), undefined);
  });
  test('the lead has no phone but the existing contact has a Canadian one on file: implied', async () => {
    assert.strictEqual(consentOf(await existingRun([], {}, { phone: CA })), 'Yes');
    assert.ok(tagPosts().includes('consent-implied-inquiry'));
  });
  test('invalid and non-Canadian foreign numbers do nothing', async () => {
    for (const phone of ['555-1212', '+44 7911 123456', 'not a phone', '+1 416 555']) {
      assert.strictEqual(consentOf(await created({ phone })), undefined, phone);
    }
  });
  test('advanced / dead-deal contacts: no implied consent (minimal update)', async () => {
    const body = await existingRun([], { phone: CA }, { tags: ['deposit'] });
    assert.strictEqual(consentOf(body), undefined);
    assert.ok(!tagPosts().includes('consent-implied-inquiry'));
  });
  test('dry run reports it (tag + Marketing Consent set) and writes nothing', async () => {
    reset(); setEnv({});
    await run(newLead({ phone: CA }));
    assert.deepEqual(writes(), []);
    const line = logs.find((l) => l.includes('WOULD CREATE'));
    assert.match(line, /consent-implied-inquiry/);
    assert.match(line, /set=\[[^\]]*Marketing Consent/);
  });
  test('libphonenumber, not "+1": Canadian vs US area codes', () => {
    const { isCanadianPhone } = require('../phone');
    assert.equal(isCanadianPhone('+14165551234'), true);
    assert.equal(isCanadianPhone('(647) 226-6568'), true);
    assert.equal(isCanadianPhone('+12125551234'), false);
    assert.equal(isCanadianPhone('212-555-1234'), false);
    assert.equal(isCanadianPhone(''), false);
  });
});

// ============ 4. corrupted upstream values (the "Annie Lamb" payload shape) ======
describe('4. "key: value" parse artifacts never become data, and never block the real value', () => {
  const ARTIFACTS = { eventType: 'estimated_guest_count:', city: 'package_name: Pro Photographer' };

  test('an artifact in a lead field is ignored (not written, not matched, not in the note) with a warning', () => {
    const plan = buildLeadPlan({ email: 'a@b.c', ...ARTIFACTS, interest: 'package_name: Pro Photographer' }, { isNewContact: true, profile: push.SOURCE_PROFILES.checkcherry, context: { proposalEmails: new Set() } });
    assert.equal(field({ customFields: plan.customFields }, FIELDS.EVENT_TYPE), undefined);
    assert.equal(plan.contactFields.city, undefined);
    assert.equal(plan.note, null);
    assert.equal(plan.warnings.filter((w) => /parse artifact/.test(w)).length, 3);
  });

  test('existing contact whose Event Type holds an artifact: the real Event Type replaces it; Event Address / Sync Key are never ours to touch', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventType: 'Corporate' });
    addContact(lead.email, { customFields: [
      { id: FIELDS.EVENT_TYPE, value: 'estimated_guest_count:' },
      { id: 'pfWvB4ENk5TaBa4ranRO', value: 'package_name: Pro Photographer' }, // Event Address
      { id: 'AoHOrIiBu4NnC8XLDmaL', value: 'lead:x|event_type:' }, // Sync Key
    ] });
    await run(lead);
    assert.equal(field(put().body, FIELDS.EVENT_TYPE), 'Corporate');
    const ids = put().body.customFields.map((f) => f.id);
    assert.ok(!ids.includes('pfWvB4ENk5TaBa4ranRO') && !ids.includes('AoHOrIiBu4NnC8XLDmaL'));
  });

  test('a VALID existing Event Type is still never overwritten', async () => {
    setEnv(LIVE);
    const lead = newLead({ eventType: 'Corporate' });
    addContact(lead.email, { customFields: [{ id: FIELDS.EVENT_TYPE, value: 'Gala' }] });
    await run(lead);
    assert.equal(field(put().body, FIELDS.EVENT_TYPE), undefined);
  });

  test('the CheckCherry payload shape (empty event type shifting the next line into it) maps to blanks, not garbage', () => {
    const sync = require('../sync');
    const lead = sync.mapCheckCherryLead({ id: 1, attributes: { email: 'pdc@example.ca', first_name: 'A', last_name: 'L', package_name: 'Pro Photographer', lead_event_type: 'estimated_guest_count:', venue_city: 'package_name: Pro Photographer' } });
    const plan = buildLeadPlan(push.toPlanBody(lead), { isNewContact: true, profile: push.SOURCE_PROFILES.checkcherry, context: { proposalEmails: new Set() } });
    assert.equal(field({ customFields: plan.customFields }, FIELDS.EVENT_TYPE), undefined);
    assert.equal(plan.contactFields.city, undefined);
    assert.deepEqual(field({ customFields: plan.customFields }, FIELDS.INTEREST) || [], []); // "Pro Photographer" is not a known interest
    assert.ok(!/estimated_guest_count|package_name/.test(plan.note || ''));
  });

  test('real values containing a colon are not mistaken for artifacts', () => {
    const { isParseArtifact } = require('../lead-shape');
    for (const v of ['Gala: black tie', 'Note: call me', 'Corporate', '']) assert.equal(isParseArtifact(v), false, v);
    for (const v of ['estimated_guest_count:', 'package_name: Pro Photographer', 'event_type:']) assert.equal(isParseArtifact(v), true, v);
  });
});
