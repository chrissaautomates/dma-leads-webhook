// With the GHL attribution field IDs UNSET (GHL_FIELD_GCLID_ID, GHL_FIELD_UTM_*_ID, ... not created yet),
// the push must skip those fields silently: no error, no null/undefined field id in any GHL payload,
// no failed contact create/update. The google-ads tag (not a field) still applies.
process.env.DB_PATH = ':memory:';
Object.keys(process.env).filter((k) => /^GHL_FIELD_(GCLID|UTM_|LEAD_CHANNEL|LEAD_ORIGIN)/.test(k)).forEach((k) => delete process.env[k]);

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, TAGS } = require('../ghl-canonical');
const { buildLeadPlan, resolveFillBlank } = require('../ghl-lead-plan');
const ghl = require('../ghl-client');
const push = require('../ghl-push');

const ATTR_KEYS = ['GCLID', 'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_TERM', 'UTM_CONTENT', 'LEAD_CHANNEL', 'LEAD_ORIGIN'];
const lead = (over = {}) => ({
  source: 'CheckCherry', name: 'Pat Lee', email: 'pat@example.com', phone: '', status: 'New', eventType: 'Corporate',
  gclid: 'Cj0KCQabc', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'spring', utmContent: 'x', utmTerm: 'kw', origin: 'Lead Form', ...over,
});
const profile = push.SOURCE_PROFILES.checkcherry;
const goodIds = (list) => list.every((f) => typeof f.id === 'string' && f.id.length > 0 && f.fieldValue !== undefined);

test('precondition: the attribution field ids are all unset', () => {
  ATTR_KEYS.forEach((k) => assert.equal(FIELDS[k], null, k));
});

test('new contact: attribution fields skipped, other fields and the google-ads tag still written', () => {
  const plan = buildLeadPlan(push.toPlanBody(lead()), { isNewContact: true, profile, context: {} });
  assert.ok(goodIds(plan.customFields));
  assert.ok(plan.customFields.some((f) => f.id === FIELDS.LAST_ACTIVITY), 'normal fields still written');
  assert.ok(plan.tags.includes(TAGS.GOOGLE_ADS));
  assert.ok(plan.fillBlank.every((e) => e.kind !== 'custom' || (typeof e.id === 'string' && e.id)));
});

test('existing contact: fill-blank has no attribution entries and resolves without error', () => {
  const plan = buildLeadPlan(push.toPlanBody(lead()), { isNewContact: false, profile, context: {} });
  assert.ok(plan.fillBlank.every((e) => e.kind !== 'custom' || (typeof e.id === 'string' && e.id)));
  const fill = resolveFillBlank(plan, { customFields: [], tags: [] });
  assert.ok(goodIds(fill.customFields));
  assert.ok(!fill.keys.some((k) => ['gclid', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'channel', 'origin'].includes(k)));
});

// --- end to end through pushLeadToGhl with a stubbed GHL client ---------------------------------
let calls; let existing;
const real = {};
beforeEach(() => {
  calls = []; existing = null;
  ['findDuplicateContact', 'getContact', 'createContact', 'updateContact', 'addTags', 'removeTags', 'createNote'].forEach((n) => { real[n] = real[n] || ghl[n]; });
  ghl.findDuplicateContact = async () => existing;
  ghl.getContact = async () => existing;
  ghl.createContact = async (body) => { calls.push(['create', body]); return { contact: { id: 'new1' }, created: true }; };
  ghl.updateContact = async (id, body) => { calls.push(['update', body]); return {}; };
  ghl.addTags = async (id, tags) => { calls.push(['addTags', tags]); };
  ghl.removeTags = async () => {};
  ghl.createNote = async () => {};
});

test('push, new contact: create succeeds with only valid field ids; google-ads tag added', async () => {
  const out = await push.pushLeadToGhl(lead(), { profile, context: {}, dryRun: false });
  assert.equal(out.action, 'create');
  const create = calls.find((c) => c[0] === 'create')[1];
  assert.ok(goodIds(create.customFields));
  assert.deepEqual(calls.find((c) => c[0] === 'addTags')[1].includes('google-ads'), true);
});

test('push, existing contact: update succeeds with only valid field ids', async () => {
  existing = { id: 'c1', email: 'pat@example.com', tags: [], customFields: [] };
  const out = await push.pushLeadToGhl(lead(), { profile, context: {}, dryRun: false });
  assert.equal(out.action, 'update');
  const upd = calls.find((c) => c[0] === 'update')[1];
  assert.ok(goodIds(upd.customFields));
});
