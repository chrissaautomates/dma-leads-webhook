process.env.DB_PATH = ':memory:';
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev', GOOGLE_ADS_CONVERSION_ACTION_ID: '555',
});
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, getAdsConversion, upsertLead } = require('../db');
const { uploadLeadConversion, classifyResponse, formatConversionTime } = require('../google-ads');
const { mapCheckCherryLead } = require('../sync');

const realFetch = global.fetch;
let calls; let adsReply;
beforeEach(() => {
  calls = []; adsReply = () => ({ status: 200, body: { results: [{ gclid: 'x' }] } });
  db.exec('DELETE FROM ads_conversions');
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = String(url).includes('oauth2') ? { status: 200, body: { access_token: 'tok' } } : adsReply();
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
});
after(() => { global.fetch = realFetch; });

const lead = (over = {}) => ({ submissionId: 'checkcherry:1', gclid: 'Cj0KCQabc', createdAtIso: new Date().toISOString(), email: 'a@b.com', name: 'A', ...over });
const ins = { action: 'inserted' };
const adsCalls = () => calls.filter((c) => c.url.includes('googleads'));

test('mapper reads gclid from attribute and from a utm param', () => {
  assert.equal(mapCheckCherryLead({ id: 1, attributes: { gclid: 'AAA', email: 'x@y.z' } }).gclid, 'AAA');
  assert.equal(mapCheckCherryLead({ id: 2, attributes: { utm_content: 'x|gclid=BBB_1', email: 'x@y.z' } }).gclid, 'BBB_1');
  assert.equal(mapCheckCherryLead({ id: 3, attributes: { email: 'x@y.z' } }).gclid, '');
});

test('uploads a click conversion for a new lead, once', async () => {
  await uploadLeadConversion(lead(), ins);
  assert.equal(adsCalls().length, 1);
  const c = adsCalls()[0];
  assert.match(c.url, /customers\/1545947716:uploadClickConversions/);
  assert.equal(c.opts.headers['developer-token'], 'dev');
  const conv = JSON.parse(c.opts.body).conversions[0];
  assert.equal(conv.conversionAction, 'customers/1545947716/conversionActions/555');
  assert.equal(conv.gclid, 'Cj0KCQabc');
  assert.equal(conv.orderId, 'checkcherry:1');
  assert.equal(getAdsConversion('checkcherry:1').status, 'uploaded');
  await uploadLeadConversion(lead(), ins); // duplicate sync
  await uploadLeadConversion(lead(), { action: 'updated' });
  assert.equal(adsCalls().length, 1);
});

test('does not upload for existing (updated) leads, no click id, or a click id already used', async () => {
  await uploadLeadConversion(lead(), { action: 'updated' });
  await uploadLeadConversion(lead({ gclid: '' }), ins);
  assert.equal(adsCalls().length, 0);
  await uploadLeadConversion(lead(), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:2' }), ins); // same gclid
  assert.equal(adsCalls().length, 1);
  assert.equal(getAdsConversion('checkcherry:2').status, 'rejected');
});

test('uses gbraid when there is no gclid', async () => {
  await uploadLeadConversion(lead({ gclid: '', gbraid: 'GB1' }), ins);
  assert.equal(JSON.parse(adsCalls()[0].opts.body).conversions[0].gbraid, 'GB1');
});

test('transient errors are retried on a later sync; partial failures are terminal', async () => {
  adsReply = () => ({ status: 503, body: { error: 'down' } });
  await uploadLeadConversion(lead(), ins);
  assert.equal(getAdsConversion('checkcherry:1').status, 'error');
  adsReply = () => ({ status: 200, body: { partialFailureError: { message: 'EXPIRED_EVENT' } } });
  await uploadLeadConversion(lead(), { action: 'updated' }); // retry of earlier error
  assert.equal(adsCalls().length, 2);
  assert.equal(getAdsConversion('checkcherry:1').status, 'rejected');
  await uploadLeadConversion(lead(), { action: 'updated' });
  assert.equal(adsCalls().length, 2);
});

test('skips test leads and clicks older than 90 days', async () => {
  await uploadLeadConversion(lead({ name: 'TEST DMA' }), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:9', gclid: 'old', createdAtIso: new Date(Date.now() - 100 * 864e5).toISOString() }), ins);
  assert.equal(adsCalls().length, 0);
});

test('classifyResponse / time format', () => {
  assert.equal(classifyResponse({ ok: false, status: 400, text: 'bad' }).status, 'rejected');
  assert.equal(classifyResponse({ ok: false, status: 401, text: 'x' }).status, 'error');
  assert.equal(formatConversionTime('2026-10-01T14:03:09-04:00'), '2026-10-01 18:03:09+00:00');
});

test('stored on the lead row, fill-only', () => {
  upsertLead({ source: 'CheckCherry', email: 'k@l.com', name: 'K', gclid: 'G1' });
  upsertLead({ source: 'CheckCherry', email: 'k@l.com', name: 'K', gclid: '' });
  assert.equal(db.prepare(`SELECT gclid FROM leads WHERE email='k@l.com'`).get().gclid, 'G1');
});

test('dry run logs the payload, sends nothing, records nothing', async () => {
  process.env.GOOGLE_ADS_UPLOAD_DRY_RUN = 'true';
  const logs = []; const orig = console.log; console.log = (m) => logs.push(String(m));
  try { await uploadLeadConversion(lead(), ins); } finally { console.log = orig; delete process.env.GOOGLE_ADS_UPLOAD_DRY_RUN; }
  assert.equal(calls.length, 0);
  assert.equal(getAdsConversion('checkcherry:1'), undefined);
  assert.ok(logs.some((l) => l.includes('DRY RUN would upload') && l.includes('conversionActions/555')));
});

test('missing conversion action id is a retryable not-configured error', async () => {
  const keep = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID; delete process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  try { await uploadLeadConversion(lead(), ins); } finally { process.env.GOOGLE_ADS_CONVERSION_ACTION_ID = keep; }
  assert.equal(calls.length, 0);
  assert.match(getAdsConversion('checkcherry:1').detail, /GOOGLE_ADS_CONVERSION_ACTION_ID/);
});
