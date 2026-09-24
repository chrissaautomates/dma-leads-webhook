// HTTP-level tests for POST /api/leads/wix, covering the 10 scenarios the
// task specified. GHL's API is fully mocked (global.fetch replaced with a
// queue-based stub) — no real network call, no real DMA contact touched.
// The local leads.db is pointed at :memory: so this never touches the real
// SQLite volume either.

process.env.DB_PATH = ':memory:';
process.env.WIX_WEBHOOK_SECRET = 'test-secret';
process.env.GHL_API_KEY = 'test-ghl-api-key';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';
// Deliberately NOT setting WEBHOOK_SECRET/ADMIN_PASSWORD — unrelated to
// this endpoint and not required for server.js to load.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS } = require('../ghl-canonical');

// --- Mock fetch -------------------------------------------------------
// Queue-based: each test enqueues the exact sequence of responses it
// expects (findDuplicateContact, then create-or-update, then addTags,
// then createNote — in that order, matching server.js's actual call
// order). Every call (URL + parsed JSON body, when present) is recorded
// in fetchCalls so tests can assert on exactly what was sent to GHL —
// including that only canonical field IDs ever appear.
let fetchQueue = [];
let fetchCalls = [];

function enqueue(status, body) {
  fetchQueue.push({ status, body });
}

function enqueueReject(err) {
  fetchQueue.push({ reject: err });
}

async function mockFetch(url, options = {}) {
  const record = { url: String(url), method: (options && options.method) || 'GET' };
  if (options && options.body) {
    try { record.body = JSON.parse(options.body); } catch { record.body = options.body; }
  }
  fetchCalls.push(record);

  const next = fetchQueue.shift();
  if (!next) throw new Error(`Unexpected fetch call with no queued mock response: ${record.method} ${record.url}`);
  if (next.reject) throw next.reject;
  const text = JSON.stringify(next.body || {});
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => text,
    json: async () => next.body || {},
  };
}

// Captured BEFORE overriding global.fetch below — this is what the test's
// own post() helper uses to actually talk to the local test server. Without
// this, replacing global.fetch would intercept the test's own outgoing
// requests too, not just ghl-client.js's calls to the (fake) GHL API.
const realFetch = global.fetch;

let app;
let baseUrl;
let server;

before(() => {
  global.fetch = mockFetch;
  // eslint-disable-next-line global-require
  app = require('../server');
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  fetchQueue = [];
  fetchCalls = [];
});

function post(path, body, headers = {}) {
  return realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret', ...headers },
    body: JSON.stringify(body),
  });
}

function findCall(urlFragment) {
  return fetchCalls.find((c) => c.url.includes(urlFragment));
}

// The create-contact URL (".../contacts/") is a substring of the
// duplicate-search URL (".../contacts/search/duplicate?...") — findCall's
// plain .includes() would match the wrong (first) call, since
// findDuplicateContact always runs first. endsWith() disambiguates them.
function findCreateContactCall() {
  return fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/'));
}

describe('POST /api/leads/wix', () => {
  test('1. new Wix lead — creates a contact, returns created:true', async () => {
    enqueue(404, {}); // findDuplicateContact: not found
    enqueue(201, { contact: { id: 'new-contact-1' } }); // createContact
    enqueue(200, {}); // addTags
    enqueue(200, {}); // createNote (message supplied below)

    const res = await post('/api/leads/wix', {
      firstName: 'Jane',
      lastName: 'Klein',
      email: 'jane.klein@example.com',
      message: 'Looking for a gala activation',
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(json, { success: true, contactId: 'new-contact-1', created: true });

    const createCall = findCreateContactCall();
    assert.equal(createCall.body.email, 'jane.klein@example.com');
    assert.equal(createCall.body.locationId, 'WWFoHKH8wu9QTuAKBUzK');
    const leadSource = createCall.body.customFields.find((f) => f.id === FIELDS.LEAD_SOURCE);
    assert.equal(leadSource.fieldValue, 'Website Form');
  });

  test('2. existing Wix lead — updates, returns created:false, does not reset Lead Status/Score', async () => {
    enqueue(200, { contact: { id: 'existing-1', email: 'returning@example.com' } }); // findDuplicateContact: found
    enqueue(200, { contact: { id: 'existing-1' } }); // updateContact
    enqueue(200, {}); // addTags

    const res = await post('/api/leads/wix', { firstName: 'Returning', email: 'returning@example.com' });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(json, { success: true, contactId: 'existing-1', created: false });

    const updateCall = fetchCalls.find((c) => c.method === 'PUT');
    assert.ok(updateCall, 'expected a PUT (update-contact) call');
    const statusField = updateCall.body.customFields.find((f) => f.id === FIELDS.LEAD_STATUS);
    const scoreField = updateCall.body.customFields.find((f) => f.id === FIELDS.LEAD_SCORE);
    assert.equal(statusField, undefined, 'DMA Lead Status must not be sent on an update');
    assert.equal(scoreField, undefined, 'Lead Score must not be sent on an update');
  });

  test('3. missing email but valid phone — looked up and created by phone', async () => {
    enqueue(404, {});
    enqueue(201, { contact: { id: 'phone-only-1' } });
    enqueue(200, {}); // addTags

    const res = await post('/api/leads/wix', { firstName: 'Sam', phone: '+15550100001' });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);

    const dupCall = findCall('/contacts/search/duplicate');
    assert.match(dupCall.url, /number=/);
    assert.doesNotMatch(dupCall.url, /email=/);
  });

  test('4. duplicate submission — create races a dup, falls back to update instead of erroring', async () => {
    enqueue(404, {}); // findDuplicateContact: not found (race — hasn't landed yet)
    enqueue(400, { message: 'This location does not allow duplicated contacts. Duplicated email found' }); // createContact rejects
    enqueue(200, { contact: { id: 'now-exists-1' } }); // internal fallback findDuplicateContact: found this time
    enqueue(200, {}); // addTags

    const res = await post('/api/leads/wix', { firstName: 'Race', email: 'race@example.com' });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(json, { success: true, contactId: 'now-exists-1', created: false });
  });

  test('5. blank optional fields — no crash, no blank custom fields sent', async () => {
    enqueue(404, {});
    enqueue(201, { contact: { id: 'minimal-1' } });
    enqueue(200, {}); // addTags

    const res = await post('/api/leads/wix', { firstName: 'Minimal', email: 'minimal@example.com', company: '', eventDate: '' });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    const createCall = findCreateContactCall();
    assert.equal(createCall.body.companyName, undefined);
    const campaignField = createCall.body.customFields.find((f) => f.id === FIELDS.CAMPAIGN);
    assert.equal(campaignField, undefined);
  });

  test('6. invalid webhook secret — 401, GHL never called', async () => {
    const res = await post('/api/leads/wix', { firstName: 'Bad', email: 'bad@example.com' }, { authorization: 'Bearer wrong-secret' });
    assert.equal(res.status, 401);
    assert.equal(fetchCalls.length, 0);
  });

  test('7. explicit marketing consent = yes', async () => {
    enqueue(404, {});
    enqueue(201, { contact: { id: 'consent-yes-1' } });
    enqueue(200, {});

    await post('/api/leads/wix', { firstName: 'Yes', email: 'yes@example.com', marketingConsent: 'yes' });
    const createCall = findCreateContactCall();
    const consentField = createCall.body.customFields.find((f) => f.id === FIELDS.MARKETING_CONSENT);
    assert.equal(consentField.fieldValue, 'Yes');
  });

  test('8. explicit marketing consent = no', async () => {
    enqueue(404, {});
    enqueue(201, { contact: { id: 'consent-no-1' } });
    enqueue(200, {});

    await post('/api/leads/wix', { firstName: 'No', email: 'no@example.com', marketingConsent: 'no' });
    const createCall = findCreateContactCall();
    const consentField = createCall.body.customFields.find((f) => f.id === FIELDS.MARKETING_CONSENT);
    assert.equal(consentField.fieldValue, 'No');
  });

  test('9. unknown interest — no DMA_Interest field, no interest tag, note preserved', async () => {
    enqueue(404, {});
    enqueue(201, { contact: { id: 'unknown-interest-1' } });
    enqueue(200, {}); // addTags
    enqueue(200, {}); // createNote — the unmapped value gets preserved there

    const res = await post('/api/leads/wix', { firstName: 'Curious', email: 'curious@example.com', interest: 'Fire Dancers' });
    const json = await res.json();
    assert.equal(json.success, true);

    const createCall = findCreateContactCall();
    const interestField = createCall.body.customFields.find((f) => f.id === FIELDS.INTEREST);
    assert.equal(interestField, undefined);

    const tagsCall = findCall('/tags');
    assert.deepEqual(tagsCall.body.tags.sort(), ['new-lead', 'source-website'].sort());

    const noteCall = findCall('/notes');
    assert.match(noteCall.body.body, /Fire Dancers/);
  });

  test('10. GHL API error — returns 502, no secret/key leaked in response', async () => {
    enqueueReject(new Error('GHL duplicate-search HTTP 500'));

    const res = await post('/api/leads/wix', { firstName: 'Error', email: 'error@example.com' });
    const json = await res.json();

    assert.equal(res.status, 502);
    assert.equal(json.success, false);
    const bodyText = JSON.stringify(json);
    assert.doesNotMatch(bodyText, /test-ghl-api-key/);
    assert.doesNotMatch(bodyText, /test-secret/);
  });

  test('validation failure — no name at all — 400, GHL never called', async () => {
    const res = await post('/api/leads/wix', { email: 'noname@example.com' });
    assert.equal(res.status, 400);
    assert.equal(fetchCalls.length, 0);
  });
});
