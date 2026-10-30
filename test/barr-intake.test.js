// Tests for the BuyAndRentRobots intake (barr-intake.js) and its backfill script. GHL is a
// route-based fetch stub, the DB is :memory: — nothing here can touch real GHL data.

process.env.DB_PATH = ':memory:';
process.env.GHL_API_KEY = 'test-ghl-api-key';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');

const barr = require('../barr-intake');
const backfill = require('../scripts/backfill-barr-leads');
const { db } = require('../db');
const { FIELDS } = require('../ghl-canonical');

let calls = [];
let ghl = {};
const realFetch = global.fetch;
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

function resetGhl() {
  calls = [];
  ghl = {
    duplicate: null, // id returned by /contacts/search/duplicate
    company: [], // contacts returned by the company search
    contact: null, // extra fields on GET /contacts/{id}
    leadSourceOptions: ['Website Form', 'BuyAndRentRobots'],
    failAll: false,
  };
}

async function mockFetch(url, options = {}) {
  const method = (options && options.method) || 'GET';
  const u = String(url);
  const record = { method, url: u };
  if (options && options.body) record.body = JSON.parse(options.body);
  calls.push(record);
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body || {}), json: async () => body || {} });
  if (ghl.failAll) return reply(500, { error: 'boom' });
  if (u.includes('/customFields')) return reply(200, { customFields: [{ id: FIELDS.LEAD_SOURCE, name: 'DMA Lead Source', picklistOptions: ghl.leadSourceOptions }] });
  if (u.includes('/contacts/search/duplicate')) return ghl.duplicate ? reply(200, { contact: { id: ghl.duplicate } }) : reply(404, {});
  if (method === 'GET' && /\/contacts\/\?/.test(u)) return reply(200, { contacts: ghl.company });
  if (method === 'GET' && /\/contacts\/[^/?]+$/.test(u)) return reply(200, { contact: { id: decodeURIComponent(u.split('/').pop()), ...(ghl.contact || {}) } });
  if (method === 'POST' && u.endsWith('/contacts/')) return reply(200, { contact: { id: `new-${calls.length}` } });
  if (method === 'PUT') return reply(200, { contact: { id: ghl.duplicate } });
  if (method === 'POST' && u.endsWith('/tags')) return reply(200, {});
  if (method === 'POST' && u.endsWith('/notes')) return reply(200, {});
  throw new Error(`unmocked GHL call: ${method} ${u}`);
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const tagCalls = () => calls.filter((c) => c.url.endsWith('/tags'));
const createCall = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/'));
const fieldValue = (call, id) => { const f = (call.body.customFields || []).find((x) => x.id === id); return f ? f.fieldValue : undefined; };

before(() => { global.fetch = mockFetch; console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
after(() => { global.fetch = realFetch; console.log = realLog; console.warn = realWarn; console.error = realError; });
beforeEach(() => {
  resetGhl();
  barr.resetLeadSourceCache();
  ['BARR_INTAKE_SECRET', 'BARR_INTAKE_LIVE', 'GHL_PUSH_DISABLED'].forEach((k) => delete process.env[k]);
});

function fakeReq(body, secret) {
  return { body, get: (h) => (h.toLowerCase() === 'x-barr-secret' ? secret : undefined) };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function post(body, secret = 's3cret') {
  const res = fakeRes();
  await barr.handleIntake(fakeReq(body, secret), res);
  return res;
}
const supplier = (over = {}) => ({ type: 'supplier', name: 'Pat Lee', email: 'Pat@Acme-Robots.com', company: 'Acme Robots', phone: '+14165550100', ...over });

describe('secret and validation', () => {
  test('no BARR_INTAKE_SECRET configured -> 503, never allowed through', async () => {
    const res = await post(supplier());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(calls, []);
  });
  test('wrong or missing secret -> 401, GHL untouched', async () => {
    process.env.BARR_INTAKE_SECRET = 's3cret';
    assert.equal((await post(supplier(), 'nope')).statusCode, 401);
    assert.equal((await post(supplier(), null)).statusCode, 401);
    assert.deepEqual(calls, []);
  });
  test('type must be supplier, renter or buyer', async () => {
    process.env.BARR_INTAKE_SECRET = 's3cret';
    for (const type of [undefined, '', 'seller', 'dma']) assert.equal((await post(supplier({ type }))).statusCode, 400);
    assert.deepEqual(calls, []);
  });
  test('needs an email or a company to match on', async () => {
    process.env.BARR_INTAKE_SECRET = 's3cret';
    assert.equal((await post({ type: 'buyer', name: 'Nobody' })).statusCode, 400);
    assert.equal((await post(supplier({ email: 'not-an-email' }))).statusCode, 400);
  });
  test('kill switch -> 503', async () => {
    process.env.BARR_INTAKE_SECRET = 's3cret';
    process.env.GHL_PUSH_DISABLED = 'true';
    assert.equal((await post(supplier())).statusCode, 503);
    assert.deepEqual(calls, []);
  });
});

describe('upsert into GHL', () => {
  beforeEach(() => { process.env.BARR_INTAKE_SECRET = 's3cret'; });

  test('default is DRY-RUN: reads, writes nothing', async () => {
    const res = await post(supplier());
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, 'dry-run');
    assert.equal(res.body.action, 'create');
    assert.deepEqual(writes(), []);
  });

  for (const type of ['supplier', 'renter', 'buyer']) {
    test(`live ${type}: new contact, only barr-${type}, Lead Source BuyAndRentRobots`, async () => {
      process.env.BARR_INTAKE_LIVE = 'true';
      const res = await post(supplier({ type }));
      assert.equal(res.body.action, 'create');
      const c = createCall();
      assert.equal(c.body.email, 'pat@acme-robots.com', 'email lowercased');
      assert.equal(c.body.source, 'BuyAndRentRobots');
      assert.equal(c.body.companyName, 'Acme Robots');
      assert.equal(fieldValue(c, FIELDS.LEAD_SOURCE), 'BuyAndRentRobots');
      assert.deepEqual(tagCalls().map((t) => t.body.tags), [[`barr-${type}`]]);
    });
  }

  test('never applies new-lead or any funnel tag, whatever the payload says', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    await post(supplier({ interest: 'AI Photo Booth, Robotics', leadType: 'Corporate', formName: 'Check Availability. Get a Quote', campaign: 'google' }));
    const sent = tagCalls().flatMap((t) => t.body.tags);
    assert.deepEqual(sent, ['barr-supplier']);
    assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'removes no tags');
  });

  test('Lead Source field is skipped (native source still set) until GHL has the option', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    ghl.leadSourceOptions = ['Website Form'];
    await post(supplier());
    const c = createCall();
    assert.equal(fieldValue(c, FIELDS.LEAD_SOURCE), undefined);
    assert.equal(c.body.source, 'BuyAndRentRobots');
  });

  test('existing contact found by email: updated, not recreated, still only the barr tag, no repeat-inquiry', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    ghl.duplicate = 'c-1';
    const res = await post(supplier({ type: 'renter' }));
    assert.equal(res.body.action, 'update');
    assert.equal(res.body.contactId, 'c-1');
    assert.equal(createCall(), undefined);
    assert.deepEqual(tagCalls().map((t) => t.body.tags), [['barr-renter']]);
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(fieldValue(put, FIELDS.LEAD_SOURCE), undefined, 'Lead Source of an existing contact is never rewritten');
  });

  test('event date before today adds barr-event-passed; today, future or unreadable does not', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    const today = new Date().toISOString().slice(0, 10);
    const tagsFor = async (eventDate) => { calls = []; await post(supplier({ type: 'renter', eventDate })); return tagCalls().flatMap((t) => t.body.tags); };
    assert.deepEqual(await tagsFor('2020-01-01'), ['barr-renter', 'barr-event-passed']);
    assert.deepEqual(await tagsFor(today), ['barr-renter']);
    assert.deepEqual(await tagsFor('2999-01-01'), ['barr-renter']);
    assert.deepEqual(await tagsFor('sometime soon'), ['barr-renter']);
    assert.deepEqual(await tagsFor(undefined), ['barr-renter']);
  });

  test('an existing advanced DMA contact gets only the barr tag too', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    ghl.duplicate = 'c-2';
    ghl.contact = { tags: ['contract won'] };
    const res = await post(supplier({ type: 'buyer' }));
    assert.equal(res.body.action, 'update-minimal');
    assert.deepEqual(tagCalls().map((t) => t.body.tags), [['barr-buyer']]);
  });

  test('no email: matches on company name (exact, case-insensitive), never on phone', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    ghl.company = [{ id: 'other', companyName: 'Acme Robots Ltd' }, { id: 'c-3', companyName: '  ACME   robots ' }];
    const res = await post(supplier({ email: '' }));
    assert.equal(res.body.matchedBy, 'company');
    assert.equal(res.body.action, 'update');
    assert.equal(res.body.contactId, 'c-3');
    assert.equal(calls.some((c) => c.url.includes('/contacts/search/duplicate')), false, 'no email/phone duplicate search');
  });

  test('no email and no company match: creates', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    ghl.company = [{ id: 'other', companyName: 'Somebody Else' }];
    const res = await post(supplier({ email: '' }));
    assert.equal(res.body.action, 'create');
    assert.equal(createCall().body.companyName, 'Acme Robots');
  });

  test('a GHL failure is a 502 (caller retries), not a crash', async () => {
    ghl.failAll = true;
    const res = await post(supplier());
    assert.equal(res.statusCode, 502);
  });
});

describe('backfill', () => {
  const csv = [
    'Submitted At,Type,Email,Company,Name,Summary',
    '2026-03-05,buyer,B@x.com,,Bea,"Wants a robot, ASAP"',
    '2026-01-02,supplier,a@x.com,Alpha,Al,',
    ',renter,undated@x.com,,Una,',
    '2026-02-01,supplier,A@X.COM,Alpha,Al again,',
    '2026-02-15,partner,p@x.com,,Pam,',
    '2026-02-20,renter,,,NoKeys,',
  ].join('\n');

  test('parses quoted fields and maps columns', () => {
    const { rows } = backfill.readRows(csv);
    assert.equal(rows.length, 6);
    assert.equal(rows[0].body.message, 'Wants a robot, ASAP');
    assert.equal(rows[0].body.type, 'buyer');
  });

  test('processes oldest first, undated last', () => {
    const order = backfill.sortOldestFirst(backfill.readRows(csv).rows).map((r) => r.body.email || r.body.name);
    assert.deepEqual(order, ['a@x.com', 'A@X.COM', 'p@x.com', 'NoKeys', 'B@x.com', 'undated@x.com']);
  });

  test('dry run: lists creates and updates, writes nothing; repeat email counts as an update', async () => {
    const out = [];
    const s = await backfill.runBackfill(backfill.readRows(csv).rows, { commit: false, log: (l) => out.push(l) });
    assert.deepEqual(writes(), []);
    assert.equal(s.create, 3);
    assert.equal(s.update, 1);
    assert.equal(s.skipped, 2);
    assert.equal(s.undated, 1);
    assert.match(out.join('\n'), /WOULD CREATE/);
    assert.match(out.join('\n'), /SKIP .*type must be one of/);
    assert.ok(out.findIndex((l) => l.includes('2026-01-02')) < out.findIndex((l) => l.includes('2026-03-05')), 'oldest printed first');
  });

  test('--commit: writes in date order, second row for the same email updates the first contact', async () => {
    const s = await backfill.runBackfill(backfill.readRows(csv).rows, { commit: true, log: () => {} });
    assert.equal(s.create, 3);
    assert.equal(s.update, 1);
    const created = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/contacts/')).map((c) => c.body.email);
    assert.deepEqual(created, ['a@x.com', 'b@x.com', 'undated@x.com']);
    const put = calls.find((c) => c.method === 'PUT');
    assert.match(put.url, /\/contacts\/new-/);
    assert.deepEqual(tagCalls().flatMap((t) => t.body.tags).sort(), ['barr-buyer', 'barr-renter', 'barr-supplier', 'barr-supplier']);
  });
});

describe('dashboard rows', () => {
  const rows = () => db.prepare(`SELECT * FROM leads WHERE target = 'BARR' ORDER BY id`).all();
  beforeEach(() => { process.env.BARR_INTAKE_SECRET = 's3cret'; db.exec(`DELETE FROM leads`); });

  test('live: adds a BARR dashboard row that the DMA push can never pick up', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    const res = await post(supplier({ type: 'renter', message: 'Need a robot', dateReceived: '2026-09-07' }));
    assert.equal(res.body.dashboard, 'inserted');
    const [row] = rows();
    assert.equal(row.email, 'pat@acme-robots.com');
    assert.equal(row.ghl_pushed, 'excluded_source');
    assert.equal(row.date_received, '2026-09-07');
    assert.equal(row.notes, 'Need a robot');
    assert.match(row.interest, /^Rental Inquiry/);
  });

  test('dry run writes no dashboard row', async () => {
    const res = await post(supplier());
    assert.equal(res.body.dashboard, 'dry-run');
    assert.equal(rows().length, 0);
  });

  test('same email twice: one row, and staff-edited notes are kept', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    await post(supplier({ message: 'first' }));
    db.exec(`UPDATE leads SET notes = 'staff note', status = 'Contacted'`);
    const res = await post(supplier({ message: 'second' }));
    assert.equal(res.body.dashboard, 'updated');
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].notes, 'staff note');
    assert.equal(rows()[0].status, 'Contacted');
  });

  test('no email: company-only lead is added once, not on every call', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    await post(supplier({ email: '' }));
    const res = await post(supplier({ email: '', company: '  ACME robots ' }));
    assert.equal(res.body.dashboard, 'exists');
    assert.equal(rows().length, 1);
  });

  test('dashboardOnly: dashboard row, no GHL calls at all', async () => {
    process.env.BARR_INTAKE_LIVE = 'true';
    const res = await post(supplier({ dashboardOnly: true }));
    assert.equal(res.body.dashboard, 'inserted');
    assert.deepEqual(calls, []);
  });

  test('backfill rows carry their own date to the dashboard', async () => {
    const sent = [];
    await backfill.runBackfill(backfill.readRows('Date,Type,Email\n2026-01-02,buyer,a@x.com\n').rows,
      { commit: true, dashboardOnly: true, dashboard: async (t, l) => { sent.push([t, l.dateReceived]); return 'inserted'; }, log: () => {} });
    assert.deepEqual(sent, [['buyer', '2026-01-02']]);
  });
});
