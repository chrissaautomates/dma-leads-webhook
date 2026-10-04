// Each source mapper must fill the normalized lead shape (lead-shape.js) instead
// of folding answers into `interest`, and that shape must flow through
// toPlanBody -> buildLeadPlan so the picklist matching actually runs.

process.env.DB_PATH = ':memory:';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../sync');
const { mapGoogleAdsLead } = require('../server');
const { toPlanBody, SOURCE_PROFILES } = require('../ghl-push');
const { buildLeadPlan } = require('../ghl-lead-plan');
const { FIELDS } = require('../ghl-canonical');

const val = (plan, id) => { const f = plan.customFields.find((x) => x.id === id); return f && f.fieldValue; };
const planFor = (lead, key) => buildLeadPlan(toPlanBody(lead), { isNewContact: true, profile: SOURCE_PROFILES[key], context: { proposalEmails: new Set() } });

describe('Wix mapper', () => {
  const form = {
    id: 'f1',
    name: 'Quote',
    fields: [
      { target: 'fn', view: { label: 'First name', fieldType: 'CONTACTS_FIRST_NAME' } },
      { target: 'em', view: { label: 'Email', fieldType: 'CONTACTS_EMAIL' } },
      { target: 'optin', view: { label: 'Can we send you information and promotion emails?', fieldType: 'RADIO_GROUP' } },
      { target: 'bud', view: { label: 'What is your budget?' } },
      { target: 'typ', view: { label: 'What type of event are you planning?' } },
      { target: 'gst', view: { label: 'How many guests are you expecting?' } },
      { target: 'dt', view: { label: 'Event date' } },
      { target: 'svc', view: { label: 'What services are you interested in?' } },
      { target: 'svc2', view: { label: 'Which experience would you like as well?' } },
      { target: 'cty', view: { label: 'City' } },
      { target: 'who', view: { label: 'Who are you?' } },
      { target: 'hear', view: { label: 'How did you hear about us?' } },
    ],
  };
  const map = (submissions) => sync.mapWixFormSubmission(
    { submissions, createdDate: '2026-10-01T12:00:00Z' },
    sync.buildFieldMetaMap(form), sync.taggedCategoriesInForm(form), 'Wix Form - Quote'
  );
  const answers = {
    fn: 'Ana', em: 'ana@example.com', optin: 'No thanks', bud: '$5,000 - $10,000', typ: 'Conference', gst: '150',
    dt: '2027-05-30', svc: 'Glambot, Robotics', svc2: 'LED Tunnel', cty: 'Toronto', who: 'Event Planner', hear: 'Google',
  };

  test('matches each label to its shape field', () => {
    const lead = map(answers);
    assert.equal(lead.email, 'ana@example.com'); // not hijacked by the opt-in question
    assert.equal(lead.marketingConsent, 'No');
    assert.equal(lead.budgetRange, '$5,000 - $10,000');
    assert.equal(lead.eventType, 'Conference');
    assert.equal(lead.guestCount, '150');
    assert.equal(lead.eventDate, '2027-05-30');
    assert.equal(lead.interest, 'Glambot, Robotics');
    assert.equal(lead.secondaryInterest, 'LED Tunnel');
    assert.equal(lead.city, 'Toronto');
    assert.equal(lead.leadType, 'Event Planner');
  });

  test('unplaceable answers go to extra, not interest', () => {
    const lead = map(answers);
    assert.equal(lead.extra, 'How did you hear about us?: Google');
    assert.ok(!lead.interest.includes('Google'));
  });

  test('flows through the plan: picklists, consent, interest options', () => {
    const plan = planFor(map(answers), 'wix');
    assert.equal(val(plan, FIELDS.MARKETING_CONSENT), 'No');
    assert.equal(val(plan, FIELDS.BUDGET_RANGE), '$5,000-$10,000');
    assert.equal(val(plan, FIELDS.EVENT_TYPE), 'Corporate');
    assert.equal(val(plan, FIELDS.EVENT_DATE), '2027-05-30');
    assert.deepEqual(val(plan, FIELDS.INTEREST).sort(), ['Glambot', 'LED Tunnel', 'Robotics']);
    assert.equal(plan.contactFields.city, 'Toronto');
    assert.match(plan.note, /How did you hear about us\?: Google/);
  });

  test('a lead with no consent answer gets Unknown on a new contact', () => {
    const { optin: _omit, ...rest } = answers;
    assert.equal(val(planFor(map(rest), 'wix'), FIELDS.MARKETING_CONSENT), 'Unknown');
  });
});

describe('Meta mapper', () => {
  const ROW = {
    id: 'l:1', created_time: '2026-10-01T10:00:00-04:00', full_name: 'Bo Li', email: 'bo@example.com', phone: 'p:+14165551212',
    'what_services_are_you_interested_in?': 'glambot, ai_photo_booth',
    'what_are_you_planning(e.g.,_gala,_conference,_festival,trade_show,_product_launch)': 'product_launch',
    'tell_us_about_your_event_goal?': 'Wow our clients',
    campaign_name: 'Fall 2026 Corporate',
  };

  test('services -> interest, planning -> eventType, goal -> extra', () => {
    const lead = sync.mapMetaAdsRow(ROW);
    assert.equal(lead.interest, 'glambot, ai_photo_booth');
    assert.equal(lead.eventType, 'product_launch');
    assert.equal(lead.extra, 'Event goal: Wow our clients');
    assert.equal(lead.campaign, 'Fall 2026 Corporate');
    assert.equal(lead.phone, '+14165551212');
  });

  test('flows through the plan (underscored Meta values still match)', () => {
    const plan = planFor(sync.mapMetaAdsRow(ROW), 'meta');
    assert.equal(val(plan, FIELDS.EVENT_TYPE), 'Product Launch');
    assert.deepEqual(val(plan, FIELDS.INTEREST).sort(), ['AI Photo Booth', 'Glambot']);
    assert.equal(val(plan, FIELDS.CAMPAIGN), 'Fall 2026 Corporate');
    assert.match(val(plan, FIELDS.LAST_ACTIVITY), /^Meta Lead Form Submission — glambot, ai_photo_booth — /);
  });

  test('skips Meta test rows', () => {
    assert.equal(sync.mapMetaAdsRow({ id: 'test:1', email: 'x@y.z' }), null);
  });
});

describe('Google Ads mapper', () => {
  const COLS = [
    { column_name: 'What type of event are you planning?', string_value: 'Private Event', column_id: 'what_type_of_event_are_you_planning?' },
    { column_name: 'When is your event date?', string_value: '05/30/2027', column_id: 'when_is_your_event_date?' },
    { column_name: 'User Email', string_value: 'idan@example.com', column_id: 'EMAIL' },
    { column_name: 'Full Name', string_value: 'Idan D', column_id: 'FULL_NAME' },
  ];
  const BODY = { campaign_id: 111, adgroup_id: 222, creative_id: 333, gcl_id: 'x' };

  test('event date -> eventDate (ISO), event type -> eventType, ids -> campaign', () => {
    const lead = mapGoogleAdsLead(COLS, BODY);
    assert.equal(lead.eventDate, '2027-05-30');
    assert.equal(lead.eventType, 'Private Event');
    assert.equal(lead.campaign, 'campaign_id=111, adgroup_id=222, creative_id=333');
    assert.equal(lead.interest, '');
  });

  test('missing ids are omitted; no body means no campaign', () => {
    assert.equal(mapGoogleAdsLead(COLS, { campaign_id: 5 }).campaign, 'campaign_id=5');
    assert.equal(mapGoogleAdsLead(COLS).campaign, '');
  });

  test('flows through the plan', () => {
    const plan = planFor(mapGoogleAdsLead(COLS, BODY), 'google');
    assert.equal(val(plan, FIELDS.EVENT_DATE), '2027-05-30');
    assert.equal(val(plan, FIELDS.EVENT_TYPE), 'Others');
    assert.equal(val(plan, FIELDS.CAMPAIGN), 'campaign_id=111, adgroup_id=222, creative_id=333');
  });
});

describe('CheckCherry mapper', () => {
  const REC = {
    id: '9', type: 'leads',
    attributes: {
      first_name: 'Cy', last_name: 'Chen', email: 'cy@example.com', phone_normalized: '+14165550000',
      venue_city: 'Toronto', venue_state: 'ON', lead_event_type: 'Gala', package_name: 'Glambot',
      event_date: '2027-03-12T00:00:00Z', guest_count: 200, budget: '$10,000-$25,000', owner: 'Richard',
      created_at: '2026-10-02T09:00:00Z', utm_campaign: 'cc-fall',
    },
  };

  test('maps venue city, event date, event type, budget, guest count and owner', () => {
    const lead = sync.mapCheckCherryLead(REC);
    assert.equal(lead.city, 'Toronto');
    assert.equal(lead.location, 'Toronto, ON');
    assert.equal(lead.eventDate, '2027-03-12');
    assert.equal(lead.eventType, 'Gala');
    assert.equal(lead.budgetRange, '$10,000-$25,000');
    assert.equal(lead.guestCount, '200');
    assert.equal(lead.owner, 'Richard');
    assert.equal(lead.interest, 'Glambot'); // the service, not the event type
  });

  test('event type is no longer used as the interest', () => {
    assert.equal(sync.mapCheckCherryLead({ attributes: { email: 'a@b.c', lead_event_type: 'Gala' } }).interest, '');
  });

  test('flows through the plan; an owner with no configured option stays in the note', () => {
    const plan = planFor(sync.mapCheckCherryLead(REC), 'checkcherry');
    assert.equal(val(plan, FIELDS.EVENT_TYPE), 'Gala');
    assert.equal(val(plan, FIELDS.BUDGET_RANGE), '$10,000-$25,000');
    assert.equal(val(plan, FIELDS.EVENT_DATE), '2027-03-12');
    assert.equal(val(plan, FIELDS.CAMPAIGN), 'cc-fall');
    assert.equal(plan.contactFields.city, 'Toronto');
    assert.equal(val(plan, FIELDS.OWNER), undefined);
    assert.match(plan.note, /Owner.*Richard/s);
  });

  test('proposal-event rows carry the venue city too', () => {
    assert.equal(sync.mapCheckCherryProposalEvent({ attributes: { customer_emails: 'a@b.c', venue_city: 'Ottawa' } }).city, 'Ottawa');
  });
});
