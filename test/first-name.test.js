// First-name hygiene: placeholders never reach GHL as a name, and the greeting
// custom field follows the rules (always on create, only with a name on update).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:'; // ghl-push.js pulls in db.js
const { cleanFirstName, buildGreeting } = require('../first-name');
const { buildLeadPlan } = require('../ghl-lead-plan');
const { SOURCE_PROFILES } = require('../ghl-push');
const { FIELDS } = require('../ghl-canonical');

const WIX = SOURCE_PROFILES.wix;
const greeting = (plan) => (plan.customFields.find((f) => f.id === FIELDS.GREETING) || {}).fieldValue;

describe('cleanFirstName / buildGreeting', () => {
  test('rejects placeholders case-insensitively and trims', () => {
    ['Prospect', ' FRIEND ', 'there', 'Valued', 'N/A', 'null', 'Undefined', '', '   ', null, undefined]
      .forEach((v) => assert.equal(cleanFirstName(v), '', String(v)));
    assert.equal(cleanFirstName('  Jane '), 'Jane');
  });

  test('greeting is "Hi {name}," or "Hi,"', () => {
    assert.equal(buildGreeting('Jane'), 'Hi Jane,');
    assert.equal(buildGreeting('Prospect'), 'Hi,');
    assert.equal(buildGreeting(''), 'Hi,');
  });
});

describe('buildLeadPlan — first name and greeting', () => {
  const saved = FIELDS.GREETING;
  FIELDS.GREETING = 'greetingFieldId';
  after(() => { FIELDS.GREETING = saved; });

  test('NEW contact without a name: firstName is "" and greeting is "Hi,"', () => {
    const plan = buildLeadPlan({ email: 'a@example.com' }, { isNewContact: true, profile: WIX });
    assert.equal(plan.contactFields.firstName, '');
    assert.equal(greeting(plan), 'Hi,');
  });

  test('NEW contact with a placeholder name behaves like no name', () => {
    const plan = buildLeadPlan({ firstName: 'Prospect', email: 'a@example.com' }, { isNewContact: true, profile: WIX });
    assert.equal(plan.contactFields.firstName, '');
    assert.equal(greeting(plan), 'Hi,');
  });

  test('NEW contact with a name: firstName and "Hi Jane," are sent (full-name input too)', () => {
    const plan = buildLeadPlan({ name: 'Jane Doe', email: 'a@example.com' }, { isNewContact: true, profile: WIX });
    assert.equal(plan.contactFields.firstName, 'Jane');
    assert.equal(greeting(plan), 'Hi Jane,');
  });

  test('EXISTING contact: no standard field written; greeting only when there is a name', () => {
    const named = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: false, profile: WIX });
    assert.equal(named.contactFields.firstName, undefined);
    assert.equal(greeting(named), 'Hi Jane,');
    const blank = buildLeadPlan({ firstName: 'Friend', email: 'a@example.com' }, { isNewContact: false, profile: WIX });
    assert.equal(blank.contactFields.firstName, undefined);
    assert.equal(greeting(blank), undefined);
  });
});
