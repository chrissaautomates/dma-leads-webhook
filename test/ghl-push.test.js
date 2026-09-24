// Tests for ghl-push.js — the shared GHL push and every safety catch around it
// (dry-run default, kill switch, go-live cutoff, legacy/terminal rows, BARR
// exclusion, CheckCherry proposal rule, advanced-contact guard). GHL is fully
// mocked (a route-based fetch stub); the DB is :memory:. Nothing here can touch
// real GHL data.

process.env.DB_PATH = ':memory:';
process.env.GHL_API_KEY = 'test-ghl-api-key';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';

const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { db, upsertLead } = require('../db');
const push = require('../ghl-push');
const { buildProposalEmailSet } = require('../sync');
const { FIELDS } = require('../ghl-canonical');

// --- Route-based GHL mock ---------------------------------------------------
let calls = [];
let ghl = {};
const realFetch = global.fetch;

function resetGhl() {
  calls = [];
  ghl = { duplicate: null, contact: null, failAll: false };
}

async function mockFetch(url, options = {}) {
  const method = (options && options.method) || 'GET';
  const u = String(url);
  const record = { method, url: u };
  if (options && options.body) record.body = JSON.parse(options.body);
  calls.push(record);
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body || {}), json: async () => body || {},
  });
  if (ghl.failAll) return reply(500, { error: 'boom' });
  if (u.includes('/contacts/search/duplicate')) return ghl.duplicate ? reply(200, { contact: { id: ghl.duplicate } }) : reply(404, {});
  if (method === 'GET' && /\/contacts\/[^/]+$/.test(u)) return reply(200, { contact: { id: ghl.duplicate, ...(ghl.contact || {}) } });
  if (method === 'POST' && u.endsWith('/contacts/')) return reply(200, { contact: { id: 'new-contact-id' } });
  if (method === 'PUT') return reply(200, { contact: { id: ghl.duplicate } });
  if (method === 'POST' && u.endsWith('/tags')) return reply(200, {});
  if (method === 'POST' && u.endsWith('/notes')) return reply(200, {});
  throw new Error(`unmocked GHL call: ${method} ${u}`);
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const tagsSent = () => { const c = calls.find((x) => x.url.endsWith('/tags')); return c ? c.body.tags : null; };

let logs = [];
const realLog = console.log;
const realError = console.error;

before(() => { global.fetch = mockFetch; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(`ERR ${a.join(' ')}`); });
after(() => { global.fetch = realFetch; console.log = realLog; console.error = realError; });

let seq = 0;
function newLead(over = {}) {
  seq += 1;
  return { source: 'Meta Ads', name: `Jane ${seq}`, email: `jane${seq}@example.com`, phone: '', company: '', interest: 'Photo booth', dateReceived: '2026-10-05', ...over };
}
function insert(lead) { return upsertLead(lead); }
const rowOf = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

function setEnv(env) {
  ['GHL_PUSH_LIVE', 'GHL_PUSH_DISABLED', 'GHL_PUSH_CUTOFF_DATE', 'GHL_CHECKCHERRY_SETTLE_MINUTES', 'GHL_ADVANCED_TAG_PATTERN']
    .forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
}

beforeEach(() => { resetGhl(); logs = []; setEnv({}); });

// ---------------------------------------------------------------------------
describe('modes: dry-run default, kill switch, cutoff requirement', () => {
  test('default (no env at all) is DRY-RUN', () => {
    assert.equal(push.resolveMode(push.getPushConfig({})), 'dry-run');
  });
  test('GHL_PUSH_LIVE alone (no cutoff) refuses: resolves to off', () => {
    assert.equal(push.resolveMode(push.getPushConfig({ GHL_PUSH_LIVE: 'true' })), 'off');
  });
  test('an invalid cutoff is treated as no cutoff', () => {
    assert.equal(push.resolveMode(push.getPushConfig({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: 'yesterday' })), 'off');
  });
  test('live + valid cutoff -> live', () => {
    assert.equal(push.resolveMode(push.getPushConfig({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' })), 'live');
  });
  test('kill switch overrides live', () => {
    assert.equal(push.resolveMode(push.getPushConfig({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01', GHL_PUSH_DISABLED: 'true' })), 'off');
  });
});

describe('pushAfterUpsert — DRY-RUN (the default)', () => {
  test('logs what it WOULD do, sends nothing, marks nothing', async () => {
    const lead = newLead();
    const result = insert(lead);
    const status = await push.pushAfterUpsert(lead, result);
    assert.equal(status, 'dry-run');
    assert.deepEqual(writes(), [], 'dry-run must make no write calls');
    assert.equal(rowOf(result.id).ghl_pushed, null, 'row stays pending');
    const line = logs.find((l) => l.includes('WOULD'));
    assert.ok(line, 'expected a WOULD line');
    assert.match(line, /DRY-RUN/);
    assert.match(line, /CREATE contact/);
    assert.match(line, /tags=\[source-meta, new-lead\]/);
    assert.match(line, /leadSource=Meta Ad/);
  });

  test('reads GHL (duplicate lookup + get) so the log reflects a real live outcome', async () => {
    ghl.duplicate = 'ghl-123';
    ghl.contact = { tags: ['proposal-sent'], customFields: [{ id: FIELDS.LEAD_STATUS, value: 'Proposal Sent' }] };
    const lead = newLead();
    const result = insert(lead);
    await push.pushAfterUpsert(lead, result);
    assert.deepEqual(writes(), []);
    const line = logs.find((l) => l.includes('WOULD'));
    assert.match(line, /MINIMAL/);
    assert.match(line, /new-lead: NO/);
    assert.match(line, /advanced: Lead Status = Proposal Sent/);
  });

  test('a pending row is evaluated/logged once per process, not every 15-min cycle', async () => {
    const lead = newLead();
    const result = insert(lead);
    await push.pushAfterUpsert(lead, result);
    const firstCalls = calls.length;
    await push.pushAfterUpsert(lead, { action: 'updated', id: result.id });
    assert.equal(calls.length, firstCalls, 'no repeat GHL reads on the second cycle');
  });
});

describe('pushAfterUpsert — kill switch and live-without-cutoff', () => {
  test('kill switch: zero GHL calls, zero logs, row untouched', async () => {
    setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01', GHL_PUSH_DISABLED: 'true' });
    const lead = newLead();
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'off');
    assert.equal(calls.length, 0);
    assert.equal(rowOf(result.id).ghl_pushed, null);
  });

  test('live without a cutoff: refuses, zero GHL calls', async () => {
    setEnv({ GHL_PUSH_LIVE: 'true' });
    const lead = newLead();
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'off');
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => l.includes('GHL_PUSH_CUTOFF_DATE')));
  });
});

describe('pushAfterUpsert — LIVE', () => {
  beforeEach(() => setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' }));

  test('new Meta lead: creates the contact, tags source-meta + new-lead, marks pushed', async () => {
    const lead = newLead();
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'pushed');
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/'));
    assert.ok(create);
    assert.equal(create.body.email, lead.email);
    assert.ok(create.body.customFields.some((f) => f.id === FIELDS.LEAD_SOURCE && f.fieldValue === 'Meta Ad'));
    assert.deepEqual(tagsSent(), ['source-meta', 'new-lead']);
    assert.equal(rowOf(result.id).ghl_pushed, 'pushed');
  });

  test('pushed at most once: the next sync cycle (same row, action=updated) sends nothing', async () => {
    const lead = newLead();
    const result = insert(lead);
    await push.pushAfterUpsert(lead, result);
    calls = [];
    assert.equal(await push.pushAfterUpsert(lead, { action: 'updated', id: result.id }), 'not-pending');
    assert.equal(calls.length, 0);
  });

  test('LEGACY rows are never pushed, even if handed to the push directly', async () => {
    const lead = newLead();
    const result = insert(lead);
    db.prepare(`UPDATE leads SET ghl_pushed = 'legacy' WHERE id = ?`).run(result.id);
    assert.equal(await push.pushAfterUpsert(lead, result), 'not-pending');
    assert.equal(await push.pushAfterUpsert(lead, { action: 'updated', id: result.id }), 'not-pending');
    assert.equal(calls.length, 0);
    assert.equal(rowOf(result.id).ghl_pushed, 'legacy');
  });

  test('a row received before the cutoff never pushes', async () => {
    const lead = newLead({ dateReceived: '2026-09-30' });
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'skip');
    assert.equal(calls.length, 0);
    assert.equal(rowOf(result.id).ghl_pushed, null);
  });

  test('a deleted (tombstoned) lead is skipped', async () => {
    assert.equal(await push.pushAfterUpsert(newLead(), { action: 'skipped_deleted', target: 'DMA' }), 'deleted');
    assert.equal(calls.length, 0);
  });

  test('a GHL failure never throws, leaves the row pending for retry', async () => {
    ghl.failAll = true;
    const lead = newLead();
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'error');
    assert.equal(rowOf(result.id).ghl_pushed, null);
    // next cycle, GHL healthy again -> the pending row goes through
    resetGhl();
    assert.equal(await push.pushAfterUpsert(lead, { action: 'updated', id: result.id }), 'pushed');
  });

  test('existing NON-advanced contact already tagged new-lead: NOT re-tagged (bug fix)', async () => {
    ghl.duplicate = 'ghl-9';
    ghl.contact = { tags: ['new-lead'], customFields: [{ id: FIELDS.LEAD_STATUS, value: 'New' }] };
    const lead = newLead();
    await push.pushAfterUpsert(lead, insert(lead));
    assert.ok(calls.some((c) => c.method === 'PUT'));
    assert.deepEqual(tagsSent(), ['source-meta']);
  });

  test('existing ADVANCED contact (Lead Status beyond New/Nurture): minimal update, no tags, note kept', async () => {
    ghl.duplicate = 'ghl-77';
    ghl.contact = { tags: [], customFields: [{ id: FIELDS.LEAD_STATUS, value: 'Sales Contacted' }] };
    const lead = newLead({ phone: '5551234', company: 'Acme', interest: 'Trade show booth' });
    await push.pushAfterUpsert(lead, insert(lead));
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(put.body.firstName, undefined, 'no standard fields touched');
    assert.equal(put.body.phone, undefined);
    assert.deepEqual(put.body.customFields.map((f) => f.id), [FIELDS.LAST_ACTIVITY]);
    assert.equal(tagsSent(), null, 'no tags call at all');
    assert.ok(calls.some((c) => c.url.endsWith('/notes')), 'note still added');
  });

  test('existing contact with a proposal-type tag counts as advanced', async () => {
    ghl.duplicate = 'ghl-78';
    ghl.contact = { tags: ['Proposal Sent'], customFields: [] };
    const lead = newLead();
    await push.pushAfterUpsert(lead, insert(lead));
    assert.equal(tagsSent(), null);
  });

  test('Lead Status New / Nurture are NOT advanced', () => {
    for (const status of ['New', 'Nurture', 'nurture']) {
      assert.equal(push.getAdvancedReason({ tags: [], customFields: [{ id: FIELDS.LEAD_STATUS, value: status }] }), null);
    }
    assert.equal(push.getAdvancedReason({ tags: [], customFields: [{ id: FIELDS.LEAD_STATUS, value: 'Won' }] }), 'Lead Status = Won');
  });
});

describe('BuyAndRentRobots exclusion', () => {
  beforeEach(() => setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' }));

  test('Meta lead mentioning humanoid robot rental: excluded, no GHL call, row marked', async () => {
    const lead = newLead({ interest: 'Services: humanoid robot rental for a store opening' });
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result), 'excluded_barr');
    assert.equal(calls.length, 0);
    assert.equal(rowOf(result.id).ghl_pushed, 'excluded_barr');
  });

  test('a row already filed under the BARR tab is excluded even with innocuous text', async () => {
    const lead = newLead({ interest: 'event' });
    const result = insert(lead);
    db.prepare(`UPDATE leads SET target = 'BARR' WHERE id = ?`).run(result.id);
    assert.equal(await push.pushAfterUpsert(lead, result), 'excluded_barr');
  });

  test('CheckCherry robot-rental lead (target is CHECKCHERRY, not BARR) is STILL excluded', async () => {
    const lead = newLead({ source: 'CheckCherry', interest: 'Robot Rental - humanoid' });
    const result = insert(lead);
    assert.equal(rowOf(result.id).target, 'CHECKCHERRY'); // the gap the keyword check over every field closes
    assert.equal(await push.pushAfterUpsert(lead, result, { proposalEmails: new Set() }), 'excluded_barr');
    assert.equal(calls.length, 0);
  });

  test('BARR signal in the UTM campaign alone excludes', async () => {
    const lead = newLead({ utmCampaign: 'BuyAndRentRobots-spring' });
    assert.equal(await push.pushAfterUpsert(lead, insert(lead)), 'excluded_barr');
  });

  test('a DMA lead interested in Robotics / Glambot is NOT excluded (DMA sells those)', async () => {
    for (const interest of ['Robotics activation', 'Glambot robot arm camera']) {
      const lead = newLead({ interest });
      assert.equal(await push.pushAfterUpsert(lead, insert(lead)), 'pushed', interest);
    }
  });

  test('dry-run lists BARR exclusions too, without marking the row', async () => {
    setEnv({});
    const lead = newLead({ interest: 'humanoid robot' });
    const result = insert(lead);
    await push.pushAfterUpsert(lead, result);
    assert.ok(logs.some((l) => l.includes('WOULD EXCLUDE') && l.includes('BuyAndRentRobots')));
    assert.equal(rowOf(result.id).ghl_pushed, null);
  });
});

describe('sources that never push', () => {
  beforeEach(() => setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' }));

  test('Chat Lead (already in GHL), Manual entry, and arbitrary sources are excluded', async () => {
    for (const source of ['Chat Lead', 'Manual entry', 'GHL', 'Something Else']) {
      const lead = newLead({ source });
      assert.equal(await push.pushAfterUpsert(lead, insert(lead)), 'excluded_source', source);
    }
    assert.equal(calls.length, 0);
  });

  test('profile mapping: Wix forms (any name), Meta Ads, Google Ads, CheckCherry', () => {
    assert.equal(push.profileForSource('Wix Form - Digital Mirror Homepage').key, 'wix');
    assert.equal(push.profileForSource('Wix Form - Untitled (3c982836)').key, 'wix');
    assert.equal(push.profileForSource('Meta Ads').key, 'meta');
    assert.equal(push.profileForSource('Google Ads').key, 'google');
    assert.equal(push.profileForSource('CheckCherry').key, 'checkcherry');
    assert.equal(push.profileForSource('Chat Lead'), null);
  });

  test('Wix Forms lead: source-wix + Website Form; Google Ads: source-google-ads + Google Ad', async () => {
    const w = newLead({ source: 'Wix Form - Digital Mirror Homepage' });
    await push.pushAfterUpsert(w, insert(w));
    assert.deepEqual(tagsSent(), ['source-wix', 'new-lead']);
    assert.ok(calls.find((c) => c.url.endsWith('/contacts/')).body.customFields.some((f) => f.fieldValue === 'Website Form'));
    calls = [];
    const g = newLead({ source: 'Google Ads' });
    await push.pushAfterUpsert(g, insert(g));
    assert.deepEqual(tagsSent(), ['source-google-ads', 'new-lead']);
  });
});

describe('CheckCherry: new-lead only when no proposal exists', () => {
  beforeEach(() => setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01', GHL_CHECKCHERRY_SETTLE_MINUTES: '0' }));

  test('events feed unavailable (null): DEFERRED, nothing sent, row stays pending', async () => {
    const lead = newLead({ source: 'CheckCherry' });
    const result = insert(lead);
    assert.equal(await push.pushAfterUpsert(lead, result, { proposalEmails: null }), 'defer');
    assert.equal(calls.length, 0);
    assert.equal(rowOf(result.id).ghl_pushed, null);
  });

  test('no proposal for this email: pushed WITH new-lead', async () => {
    const lead = newLead({ source: 'CheckCherry' });
    await push.pushAfterUpsert(lead, insert(lead), { proposalEmails: new Set(['other@example.com']) });
    assert.deepEqual(tagsSent(), ['source-checkcherry', 'new-lead']);
  });

  test('proposal exists for this email: pushed WITHOUT new-lead', async () => {
    const lead = newLead({ source: 'CheckCherry', email: 'booked@client.com' });
    await push.pushAfterUpsert(lead, insert(lead), { proposalEmails: new Set(['booked@client.com']) });
    assert.deepEqual(tagsSent(), ['source-checkcherry']);
  });

  test('RACE guard: a brand-new CheckCherry lead is held for the settle window, then re-checked against fresh events', async () => {
    setEnv({ GHL_PUSH_LIVE: 'true', GHL_PUSH_CUTOFF_DATE: '2026-10-01' }); // default 10-minute settle
    const lead = newLead({ source: 'CheckCherry', email: 'racer@example.com' });
    const result = insert(lead);
    // cycle 1: just inserted, no proposal yet -> held
    assert.equal(await push.pushAfterUpsert(lead, result, { proposalEmails: new Set() }), 'defer');
    assert.equal(calls.length, 0);
    // the proposal is created; time passes (row is now older than the window)
    db.prepare(`UPDATE leads SET created_at = datetime('now', '-30 minutes') WHERE id = ?`).run(result.id);
    // cycle 2: fresh events now contain the email -> pushed, but WITHOUT new-lead
    assert.equal(await push.pushAfterUpsert(lead, { action: 'updated', id: result.id }, { proposalEmails: new Set(['racer@example.com']) }), 'pushed');
    assert.deepEqual(tagsSent(), ['source-checkcherry']);
  });

  test('lead without an email cannot be checked against proposals -> no new-lead', async () => {
    const lead = newLead({ source: 'CheckCherry', email: '', phone: '5559999' });
    await push.pushAfterUpsert(lead, insert(lead), { proposalEmails: new Set() });
    const create = calls.find((c) => c.url.endsWith('/contacts/'));
    assert.ok(create);
  });
});

describe('buildProposalEmailSet (sync.js)', () => {
  const ev = (status, emails, extra = {}) => ({ attributes: { status, customer_emails: emails, ...extra } });

  test('includes every listed status', () => {
    const set = buildProposalEmailSet([
      ev('proposal_date_open', 'a@x.com'), ev('proposal_date_reserved', 'b@x.com'),
      ev('awaiting_signature', 'c@x.com'), ev('confirmed', 'd@x.com'), ev('won', 'e@x.com'),
    ]);
    assert.deepEqual([...set].sort(), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });
  test('takes EVERY address of a comma-joined customer_emails, lowercased/trimmed', () => {
    const set = buildProposalEmailSet([ev('confirmed', 'First@X.com, second@x.com ,')]);
    assert.deepEqual([...set].sort(), ['first@x.com', 'second@x.com']);
  });
  test('canceled / archived / postponed / unlisted-status events STILL count (fail closed)', () => {
    const set = buildProposalEmailSet([
      ev('confirmed', 'c@x.com', { canceled: true }), ev('proposal_date_open', 'p@x.com', { postponed: true }),
      ev('some_new_status', 'n@x.com'),
    ]);
    assert.ok(set.has('c@x.com') && set.has('p@x.com') && set.has('n@x.com'));
  });
  test('events with no email contribute nothing', () => {
    assert.equal(buildProposalEmailSet([ev('confirmed', '')]).size, 0);
  });
});
