process.env.DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapGoogleAdsLead } = require('../server');

// Real payload from the first live Google Ads submission (2026-09-29).
const REAL = [
  { column_name: 'What type of event are you planning?', string_value: 'Private Event', column_id: 'what_type_of_event_are_you_planning?' },
  { column_name: 'When is your event date?', string_value: '05/30/2027', column_id: 'when_is_your_event_date?' },
  { column_name: 'Full Name', string_value: 'Idan Driman', column_id: 'FULL_NAME' },
  { column_name: 'User Email', string_value: 'idandriman@gmail.com', column_id: 'EMAIL' },
  { column_name: 'User Phone', string_value: '+16472266568', column_id: 'PHONE_NUMBER' },
  { column_name: 'Phone Number Verified', string_value: 'FALSE', column_id: 'PHONE_NUMBER_VERIFIED' },
  { column_name: 'Company Name', string_value: 'Bar Mitzva', column_id: 'COMPANY_NAME' },
];

test('maps the real Google Ads payload including email and phone', () => {
  const lead = mapGoogleAdsLead(REAL);
  assert.equal(lead.name, 'Idan Driman');
  assert.equal(lead.email, 'idandriman@gmail.com');
  assert.equal(lead.phone, '+16472266568');
  assert.equal(lead.company, 'Bar Mitzva');
  assert.equal(lead.interest, 'Private Event');
  assert.equal(lead.notes, 'Event date: 05/30/2027');
});

test('redactGoogleKey drops google_key but keeps every other top-level field', () => {
  const { redactGoogleKey } = require('../server');
  const body = { google_key: 'secret', campaign_id: 1, adgroup_id: 2, creative_id: 3, gcl_id: 'x', user_column_data: [] };
  const out = redactGoogleKey(body);
  assert.equal('google_key' in out, false);
  assert.deepEqual(out, { campaign_id: 1, adgroup_id: 2, creative_id: 3, gcl_id: 'x', user_column_data: [] });
  assert.equal(body.google_key, 'secret'); // input not mutated
});
