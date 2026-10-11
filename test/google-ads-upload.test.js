process.env.DB_PATH = ':memory:';
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt', GOOGLE_ADS_CONVERSION_SHEET_ID: 'SHEET1' });
const crypto = require('node:crypto');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, getAdsConversion, upsertLead } = require('../db');
const { uploadLeadConversion, buildRow, formatConversionTime, hashEmail, hashPhone } = require('../google-ads');
const { mapCheckCherryLead } = require('../sync');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const realFetch = global.fetch;
let calls; let sheetRows; let sheetFail;
beforeEach(() => {
  calls = []; sheetRows = [['Google Click ID', 'Conversion Time', 'Conversion Value', 'Conversion Currency', 'Order ID', 'Email', 'Phone']]; sheetFail = null;
  db.exec('DELETE FROM ads_conversions');
  global.fetch = async (url, opts = {}) => {
    url = String(url); calls.push({ url, opts });
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (url.includes('oauth2.googleapis.com/token')) return reply(200, { access_token: 'tok' });
    if (sheetFail) return reply(sheetFail, { error: 'x' });
    if (url.includes(':append')) { sheetRows.push(JSON.parse(opts.body).values[0]); return reply(200, { updates: { updatedRows: 1 } }); }
    if (url.includes('/values/')) return reply(200, { values: sheetRows.map((r) => [r[4]]) });
    return reply(200, { sheets: [{ properties: { title: "Leads 'A'" } }] });
  };
});
after(() => { global.fetch = realFetch; });

const lead = (over = {}) => ({ submissionId: 'checkcherry:77', gclid: 'Cj0KCQabc', email: ' Test@Example.COM ', phone: '+1 416 363 8888', createdAtIso: new Date(Date.now() - 3600e3).toISOString(), name: 'A', ...over });
const ins = { action: 'inserted' };
const appended = () => calls.filter((c) => c.url.includes(':append'));

test('conversion time is America/Toronto and DST aware', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  assert.equal(formatConversionTime('2026-10-11T23:20:00Z', now), '2026-10-11 19:20:00-04:00');
  assert.equal(formatConversionTime('2026-01-15T17:05:09Z', now), '2026-01-15 12:05:09-05:00');
  assert.equal(formatConversionTime('2026-11-01T05:59:59Z', now), '2026-11-01 01:59:59-04:00'); // last second of EDT
  assert.equal(formatConversionTime('2026-11-01T06:00:00Z', now), '2026-11-01 01:00:00-05:00'); // fall back
  assert.equal(formatConversionTime('2026-03-08T06:59:59Z', now), '2026-03-08 01:59:59-05:00'); // last second of EST
  assert.equal(formatConversionTime('2026-03-08T07:00:00Z', now), '2026-03-08 03:00:00-04:00'); // spring forward
  assert.equal(formatConversionTime('2026-10-11T01:10:04.185-04:00', now), '2026-10-11 01:10:04-04:00'); // CheckCherry's own format
});

test('email and phone hashes: trimmed/lowercased email, E.164 phone', () => {
  assert.equal(hashEmail('  Test@Example.COM '), sha('test@example.com'));
  assert.equal(hashEmail(''), '');
  assert.equal(hashPhone('(416) 363-8888'), sha('+14163638888'));
  assert.equal(hashPhone('+1 416 363 8888'), sha('+14163638888'));
  assert.equal(hashPhone('not a phone'), '');
});

test('row has the 7 columns in order; value blank; currency CAD; order id is the CheckCherry lead id', () => {
  const r = buildRow(lead({ createdAtIso: '2026-10-11T23:20:00Z' }));
  assert.deepEqual(r, ['Cj0KCQabc', r[1], '', 'CAD', '77', sha('test@example.com'), sha('+14163638888')]);
  assert.match(r[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('a row needs a gclid, an email or a phone', () => {
  assert.equal(buildRow(lead({ gclid: '', email: '', phone: '' })), null);
  assert.equal(buildRow(lead({ gclid: '', email: '', phone: 'garbage' })), null);
  assert.equal(buildRow(lead({ gclid: '', email: '', phone: '+14163638888' }))[0], '');
  assert.equal(buildRow(lead({ gclid: '', phone: '' }))[0], '');
});

test('appends one row to the first tab, then skips the same order id', async () => {
  await uploadLeadConversion(lead(), ins);
  assert.equal(appended().length, 1);
  assert.match(decodeURIComponent(appended()[0].url), /'Leads ''A'''!A:G:append\?valueInputOption=RAW/);
  assert.equal(sheetRows.length, 2);
  assert.equal(getAdsConversion('checkcherry:77').status, 'uploaded');
  await uploadLeadConversion(lead(), ins);
  await uploadLeadConversion(lead(), { action: 'updated' });
  assert.equal(appended().length, 1);
});

test('skips when the order id is already in column E (e.g. lost local state)', async () => {
  sheetRows.push(['', '', '', 'CAD', '77', '', '']);
  await uploadLeadConversion(lead(), ins);
  assert.equal(appended().length, 0);
});

test('existing (updated) leads are not appended; no gclid/email/phone is skipped', async () => {
  await uploadLeadConversion(lead(), { action: 'updated' });
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:78', gclid: '', email: '', phone: '' }), ins);
  assert.equal(calls.length, 0);
});

test('sheet failures are recorded and retried on a later sync', async () => {
  sheetFail = 503;
  await uploadLeadConversion(lead(), ins);
  assert.equal(getAdsConversion('checkcherry:77').status, 'error');
  sheetFail = null;
  await uploadLeadConversion(lead(), { action: 'updated' });
  assert.equal(appended().length, 1);
  assert.equal(getAdsConversion('checkcherry:77').status, 'uploaded');
});

test('missing configuration is a retryable error and sends nothing', async () => {
  const keep = process.env.GOOGLE_ADS_CONVERSION_SHEET_ID; delete process.env.GOOGLE_ADS_CONVERSION_SHEET_ID;
  try { await uploadLeadConversion(lead(), ins); } finally { process.env.GOOGLE_ADS_CONVERSION_SHEET_ID = keep; }
  assert.equal(calls.length, 0);
  assert.match(getAdsConversion('checkcherry:77').detail, /GOOGLE_ADS_CONVERSION_SHEET_ID/);
});

test('dry run logs the row, makes no request and records nothing', async () => {
  process.env.GOOGLE_ADS_UPLOAD_DRY_RUN = 'true';
  const logs = []; const orig = console.log; console.log = (m) => logs.push(String(m));
  try { await uploadLeadConversion(lead(), ins); } finally { console.log = orig; delete process.env.GOOGLE_ADS_UPLOAD_DRY_RUN; }
  assert.equal(calls.length, 0);
  assert.equal(getAdsConversion('checkcherry:77'), undefined);
  assert.ok(logs.some((l) => l.includes('DRY RUN would append') && l.includes('"Cj0KCQabc"') && l.includes(sha('test@example.com')) && !l.includes('Example')));
});

test('skips test leads, spam, and (with a gclid) clicks older than 90 days', async () => {
  await uploadLeadConversion(lead({ name: 'TEST DMA' }), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:2', status: 'Spam' }), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:3', createdAtIso: new Date(Date.now() - 100 * 864e5).toISOString() }), ins);
  assert.equal(calls.length, 0);
});

test('skips test data: gclid starting with TEST, or utm_campaign "test"', async () => {
  await uploadLeadConversion(lead({ gclid: 'TEST123' }), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:5', gclid: 'tEsT9' }), ins);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:6', utmCampaign: ' Test ' }), ins);
  assert.equal(calls.length, 0);
  await uploadLeadConversion(lead({ submissionId: 'checkcherry:7', utmCampaign: 'spring_promo' }), ins);
  assert.equal(appended().length, 1);
});

test('mapper carries gclid and the created time; the lead row stores the gclid', () => {
  const l = mapCheckCherryLead({ id: 5, attributes: { email: 'k@l.com', gclid: 'G1', created_at: '2026-10-11T01:10:04.185-04:00' } });
  assert.equal(l.gclid, 'G1'); assert.equal(l.createdAtIso, '2026-10-11T01:10:04.185-04:00');
  upsertLead({ source: 'CheckCherry', email: 'k@l.com', name: 'K', gclid: 'G1' });
  upsertLead({ source: 'CheckCherry', email: 'k@l.com', name: 'K', gclid: '' });
  assert.equal(db.prepare(`SELECT gclid FROM leads WHERE email='k@l.com'`).get().gclid, 'G1');
});
