process.env.DB_PATH = ':memory:';
const ENV_IDS = { GCLID: 'f-gclid', UTM_SOURCE: 'f-src', UTM_MEDIUM: 'f-med', UTM_CAMPAIGN: 'f-camp', UTM_TERM: 'f-term', UTM_CONTENT: 'f-cont', LEAD_CHANNEL: 'f-chan', LEAD_ORIGIN: 'f-orig' };
Object.entries(ENV_IDS).forEach(([k, v]) => { process.env[`GHL_FIELD_${k}_ID`] = v; });

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractAttribution, deriveChannel, attributionValues, parseQuery, tokenFrom } = require('../attribution');
const { buildLeadPlan, resolveFillBlank } = require('../ghl-lead-plan');
const { mapCheckCherryLead, mapCheckCherryProposalEvent } = require('../sync');
const { toPlanBody, SOURCE_PROFILES } = require('../ghl-push');
const { TAGS } = require('../ghl-canonical');
const backfill = require('../scripts/backfill-attribution');

const profile = SOURCE_PROFILES.checkcherry;
const lead = (over = {}) => ({ source: 'CheckCherry', name: 'A B', email: 'a@b.com', phone: '', status: 'New', ...over });
const plan = (l, isNew = true) => buildLeadPlan(toPlanBody(l), { isNewContact: isNew, profile, context: {} });
const written = (p) => Object.fromEntries(p.customFields.map((f) => [f.id, f.fieldValue]));

describe('parsing', () => {
  test('reads the live CheckCherry attribute names (gclid, utm_*, source, origin)', () => {
    const a = extractAttribution({ gclid: 'TEST123', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'c', utm_term: 't', utm_content: 'hero_cta', source: 'Google', origin: 'Lead Form' });
    assert.deepEqual(a, { gclid: 'TEST123', gbraid: '', wbraid: '', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'c', utmContent: 'hero_cta', utmTerm: 't', ccSource: 'Google', origin: 'Lead Form' });
  });
  test('null / missing attributes become blanks; a click id hidden in a utm value is found', () => {
    assert.equal(extractAttribution({ gclid: null, utm_source: null }).gclid, '');
    assert.equal(extractAttribution({ utm_content: 'x|gbraid=GB_9' }).gbraid, 'GB_9');
    assert.equal(extractAttribution(undefined).utmSource, '');
  });
  test('a spam record carries no click ids', () => {
    const a = extractAttribution({ spam: true, gclid: 'G', utm_source: 'google' });
    assert.equal(a.gclid, ''); assert.equal(a.utmSource, 'google');
  });
  test('parseQuery / tokenFrom pull params out of a URL', () => {
    const q = parseQuery('https://www.digitalmirror.ca/torontoaiphotobooth?gclid=TEST123&utm_source=google&utm_medium=cpc&utm_campaign=test%20one#x');
    assert.deepEqual(q, { gclid: 'TEST123', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'test one' });
    assert.equal(tokenFrom('a=1&gclid=ABC-1&b=2', 'gclid'), 'ABC-1');
  });
  test('lead and event mappers both carry the attribution', () => {
    const rec = { id: 1, attributes: { email: 'x@y.z', gclid: 'G1', utm_source: 'google', origin: 'Online Booking', source: 'Google', created_at: '2026-10-11T01:10:04.185-04:00' } };
    const l = mapCheckCherryLead(rec);
    assert.equal(l.gclid, 'G1'); assert.equal(l.origin, 'Online Booking'); assert.equal(l.ccSource, 'Google'); assert.equal(l.utmSource, 'google');
    const e = mapCheckCherryProposalEvent({ id: 2, attributes: { customer_emails: ['x@y.z'], gclid: 'G2', utm_medium: 'organic' } });
    assert.equal(e.gclid, 'G2'); assert.equal(e.utmMedium, 'organic');
  });
});

describe('lead_channel', () => {
  test('only a click id proves Google Ads', () => {
    assert.equal(deriveChannel({ gclid: 'x' }), 'Google Ads');
    assert.equal(deriveChannel({ gbraid: 'x', utmSource: 'facebook' }), 'Google Ads');
    assert.equal(deriveChannel({ wbraid: 'x' }), 'Google Ads');
    assert.equal(deriveChannel({ gclid: 'x', utmContent: 'hero_cta', utmSource: 'google', utmMedium: 'cpc' }), 'Google Ads');
  });
  test('google/cpc without a click id is unverified', () => {
    assert.equal(deriveChannel({ utmSource: 'google', utmMedium: 'cpc' }), 'Google (unverified)');
    assert.equal(deriveChannel({ utmSource: 'Google', utmMedium: 'CPC', utmContent: 'other' }), 'Google (unverified)');
  });
  test('hero_cta without a click id is Website, even with the hardcoded google/cpc', () => {
    assert.equal(deriveChannel({ utmSource: 'google', utmMedium: 'cpc', utmContent: 'hero_cta' }), 'Website');
    assert.equal(deriveChannel({ utmContent: 'hero_cta' }), 'Website');
  });
  test('Meta, other sources, and unknown', () => {
    ['facebook', 'Instagram', 'meta'].forEach((s) => assert.equal(deriveChannel({ utmSource: s }), 'Meta Ads'));
    assert.equal(deriveChannel({ utmSource: 'google', utmMedium: 'organic' }), 'google');
    assert.equal(deriveChannel({ utmSource: 'digitalmirror.ca', utmMedium: 'website' }), 'digitalmirror.ca');
    assert.equal(deriveChannel({}), 'Direct / Unknown');
  });
});

describe('GHL plan: values, tag, first touch', () => {
  const full = { gclid: 'TEST123', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'test', utmContent: 'x', utmTerm: 'kw', origin: 'Online Booking' };

  test('new contact: every value written, google-ads tag added', () => {
    const p = plan(lead(full));
    assert.deepEqual(Object.fromEntries(Object.entries(written(p)).filter(([id]) => id.startsWith('f-'))),
      { 'f-gclid': 'TEST123', 'f-src': 'google', 'f-med': 'cpc', 'f-camp': 'test', 'f-term': 'kw', 'f-cont': 'x', 'f-chan': 'Google Ads', 'f-orig': 'Online Booking' });
    assert.ok(p.tags.includes(TAGS.GOOGLE_ADS));
  });
  test('unverified / website channels do NOT get the google-ads tag', () => {
    assert.ok(!plan(lead({ utmSource: 'google', utmMedium: 'cpc' })).tags.includes('google-ads'));
    assert.ok(!plan(lead({ utmSource: 'google', utmMedium: 'cpc', utmContent: 'hero_cta' })).tags.includes('google-ads'));
  });
  test('existing contact: attribution goes only through fill-blank, never overwrites', () => {
    const p = plan(lead({ ...full, gclid: 'NEW', utmSource: 'facebook' }), false);
    assert.equal(p.customFields.filter((f) => String(f.id).startsWith('f-')).length, 0); // nothing written directly
    const contact = { customFields: [{ id: 'f-gclid', value: 'FIRST' }, { id: 'f-src', value: 'google' }] };
    const fill = resolveFillBlank(p, contact);
    const ids = fill.customFields.map((f) => f.id);
    assert.ok(!ids.includes('f-gclid') && !ids.includes('f-src')); // first touch kept
    assert.ok(ids.includes('f-med') && ids.includes('f-chan')); // blanks filled
  });
  test('an empty incoming value never blanks an existing one', () => {
    const p = plan(lead({ utmSource: 'google', gclid: '' }), false);
    assert.ok(!p.fillBlank.some((e) => e.key === 'gclid'));
  });
  test('idempotent: once filled, a second pass fills nothing', () => {
    const p = plan(lead(full), false);
    const first = resolveFillBlank(p, { customFields: [] });
    const after = { customFields: first.customFields.map((f) => ({ id: f.id, value: f.fieldValue })) };
    assert.equal(resolveFillBlank(p, after).customFields.length, 0);
  });
  test('spam and non-CheckCherry leads get no attribution', () => {
    assert.deepEqual(attributionValues(lead({ ...full, status: 'Spam' })), []);
    assert.deepEqual(attributionValues(lead({ ...full, source: 'Wix Form - X' })), []);
    assert.ok(!plan(lead({ ...full, status: 'Spam' })).tags.includes('google-ads'));
  });
  test('a CheckCherry lead with no UTMs is recorded as Direct / Unknown', () => {
    assert.equal(written(plan(lead()))['f-chan'], 'Direct / Unknown');
  });
});

describe('backfill', () => {
  const cand = (over) => ({ kind: 'lead', id: '1', email: 'a@b.com', phone: '', createdAt: '2026-10-01T00:00:00Z', spam: false, status: 'New', source: 'CheckCherry', gclid: '', gbraid: '', wbraid: '', utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '', ccSource: '', origin: '', ...over });
  const ids = { GCLID: 'f-gclid', UTM_SOURCE: 'f-src', UTM_MEDIUM: 'f-med', UTM_CAMPAIGN: 'f-camp', UTM_TERM: 'f-term', UTM_CONTENT: 'f-cont', LEAD_CHANNEL: 'f-chan', LEAD_ORIGIN: 'f-orig' };
  function deps(contacts) {
    const calls = { updates: [], tags: [] };
    return {
      calls,
      findContact: async ({ email }) => contacts[email] || null,
      updateContact: async (id, body) => { calls.updates.push({ id, body }); contacts[id.replace('c-', '')] = contacts[id.replace('c-', '')]; },
      addTags: async (id, t) => calls.tags.push({ id, t }),
    };
  }

  test('dry run writes nothing; summary counts matched / updated / skipped / no attribution / not found', async () => {
    const contacts = { 'a@b.com': { id: 'c-a', tags: [], customFields: [] }, 'filled@b.com': { id: 'c-f', tags: ['google-ads'], customFields: Object.values(ids).map((id) => ({ id, value: 'x' })) } };
    const d = deps(contacts);
    const s = await backfill.run([
      cand({ gclid: 'G', utmSource: 'google', utmMedium: 'cpc' }),
      cand({ id: '2', email: 'filled@b.com', gclid: 'G2', utmSource: 'google' }),
      cand({ id: '3', email: 'none@b.com', utmSource: 'google', utmMedium: 'cpc' }),
      cand({ id: '4', email: 'blank@b.com' }),
      cand({ id: '5', email: 'spam@b.com', gclid: 'S', spam: true }),
    ], d, { fieldIds: ids });
    assert.equal(d.calls.updates.length + d.calls.tags.length, 0);
    assert.deepEqual([s.matched, s.updated, s.skipped, s.noAttribution, s.notInGhl, s.spamIgnored, s.tagged], [2, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(s.byChannel, { 'Google Ads': 2, 'Google (unverified)': 1 });
  });

  test('--apply fills blanks only, tags Google Ads contacts, and a second run changes nothing', async () => {
    const contact = { id: 'c-a', tags: [], customFields: [{ id: 'f-src', value: 'facebook' }] };
    const d = deps({ 'a@b.com': contact });
    const c = [cand({ gclid: 'G', utmSource: 'google', utmMedium: 'cpc' })];
    const s = await backfill.run(c, d, { apply: true, fieldIds: ids });
    const body = d.calls.updates[0].body.customFields;
    assert.ok(!body.some((f) => f.id === 'f-src')); // first touch kept
    assert.ok(body.some((f) => f.id === 'f-gclid' && f.fieldValue === 'G'));
    assert.deepEqual(d.calls.tags, [{ id: 'c-a', t: ['google-ads'] }]);
    assert.equal(s.updated, 1);
    // simulate GHL state after the write, then re-run
    contact.customFields.push(...body.map((f) => ({ id: f.id, value: f.fieldValue }))); contact.tags.push('google-ads');
    const d2 = deps({ 'a@b.com': contact });
    const s2 = await backfill.run(c, d2, { apply: true, fieldIds: ids });
    assert.equal(d2.calls.updates.length + d2.calls.tags.length, 0);
    assert.equal(s2.skipped, 1);
  });

  test('oldest record with a signal wins per person (first touch)', async () => {
    const d = deps({ 'a@b.com': { id: 'c-a', tags: [], customFields: [] } });
    await backfill.run([
      cand({ id: 'new', createdAt: '2026-10-09T00:00:00Z', gclid: 'LATER' }),
      cand({ id: 'old', createdAt: '2026-09-20T00:00:00Z', utmSource: 'digitalmirror.ca', utmMedium: 'website' }),
    ], d, { apply: true, fieldIds: ids });
    const body = Object.fromEntries(d.calls.updates[0].body.customFields.map((f) => [f.id, f.fieldValue]));
    assert.equal(body['f-src'], 'digitalmirror.ca');
    assert.ok(!('f-gclid' in body));
  });

  test('--apply refuses to write while GHL fields are not configured', async () => {
    const d = deps({ 'a@b.com': { id: 'c-a', tags: [], customFields: [] } });
    const s = await backfill.run([cand({ gclid: 'G' })], d, { apply: true, fieldIds: {} });
    assert.equal(s.errors, 1); assert.equal(d.calls.updates.length, 0);
    assert.ok(s.fieldsNotConfigured.includes('GCLID'));
  });
});
