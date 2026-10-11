// With the attribution field ids SET: a lead with no gclid / UTMs still syncs cleanly, and a GHL
// rejection caused by attribution fields cannot fail the whole contact create / update.
process.env.DB_PATH = ':memory:';
const IDS = { GCLID: 'f-gclid', UTM_SOURCE: 'f-src', UTM_MEDIUM: 'f-med', UTM_CAMPAIGN: 'f-camp', UTM_TERM: 'f-term', UTM_CONTENT: 'f-cont', LEAD_CHANNEL: 'f-chan', LEAD_ORIGIN: 'f-orig' };
Object.entries(IDS).forEach(([k, v]) => { process.env[`GHL_FIELD_${k}_ID`] = v; });

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ghl = require('../ghl-client');
const push = require('../ghl-push');

const profile = push.SOURCE_PROFILES.checkcherry;
const ATTR_IDS = new Set(Object.values(IDS));
const bare = { source: 'CheckCherry', name: 'Pat Lee', email: 'pat@example.com', phone: '', status: 'New', eventType: 'Corporate' };
const full = { ...bare, gclid: 'G1', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'c', origin: 'Lead Form' };
const hasAttr = (cf) => cf.some((f) => ATTR_IDS.has(f.id));

let calls; let existing; let reject; const real = {};
beforeEach(() => {
  calls = []; existing = null; reject = null;
  ['findDuplicateContact', 'getContact', 'createContact', 'updateContact', 'addTags', 'removeTags', 'createNote'].forEach((n) => { real[n] = real[n] || ghl[n]; });
  ghl.findDuplicateContact = async () => existing;
  ghl.getContact = async () => existing;
  const guarded = (kind) => async (...args) => {
    const body = args[args.length - 1];
    calls.push([kind, body]);
    if (reject && reject(body)) { const e = new Error(`GHL ${kind} HTTP ${reject(body)}`); e.status = reject(body); e.body = 'bad custom field'; throw e; }
    return kind === 'create' ? { contact: { id: 'new1' }, created: true } : {};
  };
  ghl.createContact = guarded('create');
  ghl.updateContact = guarded('update');
  ghl.addTags = async () => {}; ghl.removeTags = async () => {}; ghl.createNote = async () => {};
});
const run = (lead) => push.pushLeadToGhl(lead, { profile, context: {}, dryRun: false });

test('a lead with no gclid or UTMs syncs cleanly (new contact): channel "Direct / Unknown", no empty values', async () => {
  const out = await run(bare);
  assert.equal(out.action, 'create');
  const cf = calls[0][1].customFields;
  assert.ok(cf.every((f) => f.id && f.fieldValue !== '' && f.fieldValue != null));
  assert.deepEqual(cf.filter((f) => ATTR_IDS.has(f.id)), [{ id: 'f-chan', fieldValue: 'Direct / Unknown' }]);
});

test('a lead with no gclid or UTMs syncs cleanly (existing contact)', async () => {
  existing = { id: 'c1', email: 'pat@example.com', tags: [], customFields: [] };
  const out = await run(bare);
  assert.equal(out.action, 'update');
  assert.equal(calls.length, 1);
});

test('new contact: GHL rejects the attribution fields (400) -> retried once without them, lead still created', async () => {
  reject = (body) => (hasAttr(body.customFields) ? 400 : 0);
  const out = await run(full);
  assert.equal(out.contactId, 'new1');
  assert.equal(calls.length, 2);
  assert.ok(hasAttr(calls[0][1].customFields) && !hasAttr(calls[1][1].customFields));
  assert.ok(calls[1][1].customFields.length > 0, 'the non-attribution fields are kept');
});

test('existing contact: same fallback on update', async () => {
  existing = { id: 'c1', email: 'pat@example.com', tags: [], customFields: [] };
  reject = (body) => (hasAttr(body.customFields) ? 422 : 0);
  const out = await run(full);
  assert.equal(out.contactId, 'c1');
  assert.equal(calls.length, 2);
  assert.ok(!hasAttr(calls[1][1].customFields));
});

test('not swallowed: a rejection that persists without attribution fields, or a 500, still throws', async () => {
  reject = () => 400;
  await assert.rejects(run(full), /HTTP/);
  assert.equal(calls.length, 2);
  calls = []; reject = (body) => (hasAttr(body.customFields) ? 500 : 0);
  await assert.rejects(run(full), /HTTP/);
  assert.equal(calls.length, 1); // 500 is not retried
});
