// Pure unit tests for wix-lead-intake.js — no HTTP, no fetch mocking, no
// database. These exercise the mapping/validation logic directly, which is
// where the actual field/tag business rules live.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateWixPayload, buildLeadPlan } = require('../wix-lead-intake');
const { FIELDS, TAGS } = require('../ghl-canonical');

function fieldValue(customFields, id) {
  const entry = customFields.find((f) => f.id === id);
  return entry ? entry.fieldValue : undefined;
}

describe('validateWixPayload', () => {
  test('accepts firstName + email', () => {
    const { valid } = validateWixPayload({ firstName: 'Jane', email: 'jane@example.com' });
    assert.equal(valid, true);
  });

  test('accepts name + phone (no firstName/email)', () => {
    const { valid } = validateWixPayload({ name: 'Jane Doe', phone: '+15550100000' });
    assert.equal(valid, true);
  });

  test('rejects missing name entirely', () => {
    const { valid, errors } = validateWixPayload({ email: 'jane@example.com' });
    assert.equal(valid, false);
    assert.match(errors.join(), /name or firstName/);
  });

  test('rejects missing email and phone', () => {
    const { valid, errors } = validateWixPayload({ firstName: 'Jane' });
    assert.equal(valid, false);
    assert.match(errors.join(), /email or phone/);
  });
});

describe('buildLeadPlan — new-lead defaults', () => {
  test('sets DMA Lead Source/Status/Score defaults on a NEW contact', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'jane@example.com' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_SOURCE), 'Website Form');
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_STATUS), 'New');
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_SCORE), 0);
  });

  test('does NOT set Lead Source/Status/Score on an EXISTING contact (no regression)', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'jane@example.com' }, { isNewContact: false });
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_SOURCE), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_STATUS), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.LEAD_SCORE), undefined);
  });

  test('DMA Last Activity is set on both new AND existing contacts', () => {
    const newPlan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: true });
    const existingPlan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: false });
    assert.match(fieldValue(newPlan.customFields, FIELDS.LAST_ACTIVITY), /^Wix Form Submission/);
    assert.match(fieldValue(existingPlan.customFields, FIELDS.LAST_ACTIVITY), /^Wix Form Submission/);
  });

  test('always applies source-website and the real new-lead tag name (not "lead-new")', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: true });
    assert.ok(plan.tags.includes(TAGS.SOURCE_WEBSITE));
    assert.ok(plan.tags.includes('new-lead'));
    assert.ok(!plan.tags.includes('lead-new')); // that literal tag does not exist
  });
});

describe('buildLeadPlan — blank optional fields', () => {
  test('omits every optional field when not supplied — never sends blank', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'jane@example.com' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.CAMPAIGN), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_DATE), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_TYPE), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.BUDGET_RANGE), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.INTEREST), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.MARKETING_CONSENT), undefined);
    assert.equal(plan.contactFields.companyName, undefined);
    assert.equal(plan.note, null);
    // Only the two always-on tags — nothing inferred.
    assert.deepEqual(plan.tags.sort(), [TAGS.SOURCE_WEBSITE, 'new-lead'].sort());
  });
});

describe('buildLeadPlan — campaign', () => {
  test('prefers explicit campaign over utmCampaign', () => {
    const plan = buildLeadPlan(
      { firstName: 'Jane', email: 'a@example.com', campaign: 'CMEE 2026', utmCampaign: 'google-fall-promo' },
      { isNewContact: true }
    );
    assert.equal(fieldValue(plan.customFields, FIELDS.CAMPAIGN), 'CMEE 2026');
  });

  test('falls back to utmCampaign when campaign is absent', () => {
    const plan = buildLeadPlan(
      { firstName: 'Jane', email: 'a@example.com', utmCampaign: 'google-fall-promo' },
      { isNewContact: true }
    );
    assert.equal(fieldValue(plan.customFields, FIELDS.CAMPAIGN), 'google-fall-promo');
  });
});

describe('buildLeadPlan — event type / budget range picklist matching', () => {
  test('matches a valid event type case-insensitively', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', eventType: 'corporate' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_TYPE), 'Corporate');
    assert.equal(plan.note, null);
  });

  test('unmapped event type is preserved in the note, not forced into the field', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', eventType: 'Bar Mitzvah' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_TYPE), undefined);
    assert.match(plan.note, /Event Type.*Bar Mitzvah/s);
  });

  test('unmapped budget range is preserved in the note, not forced into the field', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', budgetRange: 'whatever we can afford' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.BUDGET_RANGE), undefined);
    assert.match(plan.note, /Budget Range.*whatever we can afford/s);
  });

  test('matches a valid budget range exactly', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', budgetRange: '$5,000-$10,000' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.BUDGET_RANGE), '$5,000-$10,000');
  });
});

describe('buildLeadPlan — interest / secondary interest', () => {
  test('AI Photo Booth interest sets both the field and interest-ai tag', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', interest: 'AI Photo Booth' }, { isNewContact: true });
    assert.deepEqual(fieldValue(plan.customFields, FIELDS.INTEREST), ['AI Photo Booth']);
    assert.ok(plan.tags.includes('interest-ai'));
  });

  test('primary + secondary interest both apply, deduped', () => {
    const plan = buildLeadPlan(
      { firstName: 'Jane', email: 'a@example.com', interest: 'AI Photo Booth', secondaryInterest: 'Trading Cards' },
      { isNewContact: true }
    );
    assert.deepEqual(fieldValue(plan.customFields, FIELDS.INTEREST).sort(), ['AI Photo Booth', 'Trading Cards'].sort());
    assert.ok(plan.tags.includes('interest-ai'));
    assert.ok(plan.tags.includes('trading cards')); // real reused tag name, not "interest-trading-cards"
  });

  test('Glambot applies its tag even though DMA_Interest has no matching option (falls back to Other)', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', interest: 'Glambot' }, { isNewContact: true });
    assert.deepEqual(fieldValue(plan.customFields, FIELDS.INTEREST), ['Other']);
    assert.ok(plan.tags.includes('interest-glambot'));
  });

  test('unrecognized interest sets neither field nor tag, preserved in note only', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', interest: 'Fire Dancers' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.INTEREST), undefined);
    assert.deepEqual(plan.tags.sort(), [TAGS.SOURCE_WEBSITE, 'new-lead'].sort());
    assert.match(plan.note, /Interest.*Fire Dancers/s);
  });
});

describe('buildLeadPlan — lead type tags', () => {
  test('Event Planner maps to the reused "planners" tag', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', leadType: 'Event Planner' }, { isNewContact: true });
    assert.ok(plan.tags.includes('planners'));
  });

  test('Conference maps to the new "type-conference" tag', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', leadType: 'Conference' }, { isNewContact: true });
    assert.ok(plan.tags.includes('type-conference'));
  });

  test('unrecognized lead type is not tagged, preserved in note only', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', leadType: 'Wedding Planner' }, { isNewContact: true });
    assert.deepEqual(plan.tags.sort(), [TAGS.SOURCE_WEBSITE, 'new-lead'].sort());
    assert.match(plan.note, /Lead Type.*Wedding Planner/s);
  });
});

describe('buildLeadPlan — marketing consent', () => {
  test('explicit "yes" sets the field to "Yes"', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', marketingConsent: 'yes' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.MARKETING_CONSENT), 'Yes');
  });

  test('explicit "no" sets the field to "No"', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com', marketingConsent: 'no' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.MARKETING_CONSENT), 'No');
  });

  test('not supplied — field omitted entirely, never defaulted to "Unknown"', () => {
    const plan = buildLeadPlan({ firstName: 'Jane', email: 'a@example.com' }, { isNewContact: true });
    assert.equal(fieldValue(plan.customFields, FIELDS.MARKETING_CONSENT), undefined);
  });
});

describe('buildLeadPlan — message preserved as a note, not inferred from', () => {
  test('message becomes a note; event fields are not extracted from it', () => {
    const plan = buildLeadPlan(
      { firstName: 'Jane', email: 'a@example.com', message: 'We need something for our gala on November 4th, about 200 guests' },
      { isNewContact: true }
    );
    assert.match(plan.note, /November 4th/);
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_DATE), undefined);
    assert.equal(fieldValue(plan.customFields, FIELDS.EVENT_TYPE), undefined);
  });
});
