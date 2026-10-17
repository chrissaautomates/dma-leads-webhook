// First-name hygiene (placeholders never reach GHL as a name) and a pin on the exact
// outgoing create-contact payload, including the shape of customFields items
// ({ id, fieldValue }). If that shape changes by accident, these tests fail.

process.env.DB_PATH = ':memory:'; // ghl-push.js pulls in db.js
process.env.GHL_API_KEY = 'test-ghl-api-key';
process.env.GHL_LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { cleanFirstName } = require('../first-name');
const { buildLeadPlan } = require('../ghl-lead-plan');
const { SOURCE_PROFILES } = require('../ghl-push');
const { FIELDS } = require('../ghl-canonical');
const ghl = require('../ghl-client');

const WIX = SOURCE_PROFILES.wix;

describe('cleanFirstName', () => {
  test('rejects placeholders case-insensitively and trims', () => {
    ['Prospect', ' FRIEND ', 'there', 'Valued', 'N/A', 'null', 'Undefined', '', '   ', null, undefined]
      .forEach((v) => assert.equal(cleanFirstName(v), '', String(v)));
    assert.equal(cleanFirstName('  Jane '), 'Jane');
  });
});

describe('buildLeadPlan — first name', () => {
  test('NEW contact without a name or with a placeholder: firstName is ""', () => {
    assert.equal(buildLeadPlan({ email: 'a@example.com' }, { isNewContact: true, profile: WIX }).contactFields.firstName, '');
    assert.equal(buildLeadPlan({ firstName: 'Prospect', email: 'a@example.com' }, { isNewContact: true, profile: WIX }).contactFields.firstName, '');
  });

  test('NEW contact with a name (or a full name): first word is sent', () => {
    assert.equal(buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: true, profile: WIX }).contactFields.firstName, 'Jane');
    assert.equal(buildLeadPlan({ name: 'Jane Doe', email: 'a@example.com' }, { isNewContact: true, profile: WIX }).contactFields.firstName, 'Jane');
  });

  test('EXISTING contact: firstName is never part of the update', () => {
    assert.equal(buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: false, profile: WIX }).contactFields.firstName, undefined);
    assert.equal(buildLeadPlan({ firstName: 'Friend', email: 'a@example.com' }, { isNewContact: false, profile: WIX }).contactFields.firstName, undefined);
  });
});

describe('outgoing create-contact payload (exact shape)', () => {
  const realFetch = global.fetch;
  let sent;
  before(() => {
    global.fetch = async (url, options) => {
      sent = { url: String(url), method: options.method, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ contact: { id: 'new-contact-id' } }) };
    };
  });
  after(() => { global.fetch = realFetch; });

  // LAST_ACTIVITY carries a timestamp; pin its shape and blank the value.
  async function payloadFor(lead) {
    const plan = buildLeadPlan(lead, { isNewContact: true, profile: WIX });
    await ghl.createContact({ ...plan.contactFields, customFields: plan.customFields });
    const body = { ...sent.body };
    body.customFields = body.customFields.map((f) => (f.id === FIELDS.LAST_ACTIVITY ? { ...f, fieldValue: '<timestamp>' } : f));
    return body;
  }

  const CUSTOM_FIELDS = [
    { id: FIELDS.LEAD_SOURCE, fieldValue: 'Website Form' },
    { id: FIELDS.LEAD_STATUS, fieldValue: 'New' },
    { id: FIELDS.LAST_ACTIVITY, fieldValue: '<timestamp>' },
  ];

  test('contact with a name', async () => {
    const body = await payloadFor({ firstName: 'Jane', email: 'jane@example.com' });
    assert.equal(sent.method, 'POST');
    assert.ok(sent.url.endsWith('/contacts/'));
    assert.deepEqual(body, { firstName: 'Jane', email: 'jane@example.com', source: 'Wix Form', locationId: 'WWFoHKH8wu9QTuAKBUzK', customFields: CUSTOM_FIELDS });
  });

  test('contact without a name: firstName is an empty string', async () => {
    const body = await payloadFor({ email: 'anon@example.com' });
    assert.deepEqual(body, { firstName: '', email: 'anon@example.com', source: 'Wix Form', locationId: 'WWFoHKH8wu9QTuAKBUzK', customFields: CUSTOM_FIELDS });
  });
});
