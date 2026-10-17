// scripts/create-ghl-fields.js against a fake GHL: picklist updates must preserve
// existing options, and a field must never be created twice.

process.env.DB_PATH = ':memory:';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GHL_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-bk-default-')); // tests never write into the repo
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { run, mergeOptions } = require('../scripts/create-ghl-fields');
const { FIELDS, FIELD_OPTIONS } = require('../ghl-canonical');

const CURRENT_INTEREST = ['Hat Bar', 'AI Photo Booth', 'Trading Cards', '360 Booth', 'Laser Engraving', 'Mosaic', 'Trade Show Engagement', 'Event Photo / Video', 'Other', 'Legacy Staff Option'];
const NEW_OPTIONS = ['Glambot', 'Robotics', 'LED Tunnel', 'DMA Engage', 'Holiday', 'Headshot'];

function fakeGhl({ fields, replaces = true, dropsOriginalsOnUpdate = false } = {}) {
  const state = { fields: JSON.parse(JSON.stringify(fields)), created: [], updates: [], lists: 0 };
  return {
    state,
    listCustomFields: async () => { state.lists++; return JSON.parse(JSON.stringify(state.fields)); },
    createCustomField: async (def) => { const f = { id: `new-${state.created.length + 1}`, ...def }; state.created.push(def); state.fields.push(f); return f; },
    updateCustomField: async (id, body) => {
      state.updates.push({ id, body });
      const f = state.fields.find((x) => x.id === id);
      const prev = f.picklistOptions || [];
      // replaces: stored list = what was sent. (A merging API would be prev ∪ sent; both must be safe.)
      f.picklistOptions = dropsOriginalsOnUpdate ? body.options.filter((o) => !prev.includes(o)) : (replaces ? body.options : [...new Set([...prev, ...body.options])]);
      return f;
    },
  };
}
const baseFields = () => [
  { id: FIELDS.INTEREST, name: 'DMA_Interest', dataType: 'MULTIPLE_OPTIONS', picklistOptions: [...CURRENT_INTEREST] },
  { id: 'x1', name: 'Event Date', dataType: 'DATE' },
];

describe('create-ghl-fields: picklist updates preserve existing options', () => {
  test('sends the FULL list: every current option (including ones not in our canonical list), in order, then the new ones', async () => {
    const g = fakeGhl({ fields: baseFields() });
    await run(g, { apply: true });
    const sent = g.state.updates[0].body.options;
    assert.deepEqual(sent.slice(0, CURRENT_INTEREST.length), CURRENT_INTEREST);
    assert.deepEqual(sent.slice(CURRENT_INTEREST.length), NEW_OPTIONS);
    assert.ok(sent.includes('Legacy Staff Option'));
    assert.equal(new Set(sent).size, sent.length, 'no duplicates');
    assert.deepEqual(g.state.fields[0].picklistOptions, sent);
  });

  test('also correct when the API merges instead of replacing', async () => {
    const g = fakeGhl({ fields: baseFields(), replaces: false });
    await run(g, { apply: true });
    assert.deepEqual(g.state.fields[0].picklistOptions.length, CURRENT_INTEREST.length + NEW_OPTIONS.length);
  });

  test('options that already exist (any case/spacing) are not added twice', async () => {
    const fields = baseFields();
    fields[0].picklistOptions.push('glambot ', 'LED  Tunnel');
    const g = fakeGhl({ fields });
    await run(g, { apply: true });
    const sent = g.state.updates[0].body.options;
    assert.equal(sent.filter((o) => /glambot/i.test(o)).length, 1);
    assert.equal(sent.filter((o) => /led\s+tunnel/i.test(o)).length, 1);
    assert.ok(sent.includes('glambot ') && sent.includes('LED  Tunnel'), 'originals keep their spelling');
  });

  test('nothing to add: no update call at all', async () => {
    const fields = baseFields();
    fields[0].picklistOptions.push(...NEW_OPTIONS);
    const g = fakeGhl({ fields });
    await run(g, { apply: true });
    assert.equal(g.state.updates.length, 0);
  });

  test('if GHL drops originals on update, the run restores the full list and fails loudly', async () => {
    const g = fakeGhl({ fields: baseFields(), dropsOriginalsOnUpdate: true });
    await assert.rejects(run(g, { apply: true }), /dropped existing options/);
    assert.equal(g.state.updates.length, 2, 'full list re-sent');
    assert.deepEqual(g.state.updates[1].body.options, g.state.updates[0].body.options);
  });

  test('picklist options returned as objects are handled', () => {
    assert.deepEqual(mergeOptions(['A', 'B'], ['b', 'C']), ['A', 'B', 'C']);
    const g = fakeGhl({ fields: [{ id: FIELDS.INTEREST, name: 'DMA_Interest', picklistOptions: [{ label: 'Hat Bar' }, { label: 'Other' }] }] });
    return run(g, { apply: true }).then(() => assert.ok(g.state.updates[0].body.options.slice(0, 2).join() === 'Hat Bar,Other'));
  });

  test('dry run changes nothing', async () => {
    const g = fakeGhl({ fields: baseFields() });
    const lines = [];
    await run(g, { apply: false, log: (l) => lines.push(l) });
    assert.equal(g.state.updates.length, 0);
    assert.equal(g.state.created.length, 0);
    assert.ok(lines.some((l) => /WOULD ADD to DMA_Interest/.test(l)));
    assert.ok(lines.some((l) => /WOULD CREATE "Guest Count"/.test(l)));
  });
});

describe('create-ghl-fields: read-after-write lag', () => {
  test('a stale listing right after the update is retried, not reported as a failure', async () => {
    const g = fakeGhl({ fields: baseFields() });
    const realList = g.listCustomFields;
    let staleReads = 2;
    let updated = false;
    const realUpdate = g.updateCustomField;
    g.updateCustomField = async (...a) => { updated = true; return realUpdate(...a); };
    g.listCustomFields = async () => {
      if (updated && staleReads-- > 0) return JSON.parse(JSON.stringify(baseFields())); // old options still shown
      return realList();
    };
    const r = await run(g, { apply: true, sleep: async () => {} });
    assert.equal(g.state.updates.length, 1, 'no restore re-send for mere lag');
    assert.ok(r.updated);
  });

  test('still fails loudly if the options never appear', async () => {
    const g = fakeGhl({ fields: baseFields() });
    const realList = g.listCustomFields;
    let updated = false;
    const realUpdate = g.updateCustomField;
    g.updateCustomField = async () => { updated = true; };
    g.listCustomFields = async () => (updated ? JSON.parse(JSON.stringify(baseFields())) : realList());
    await assert.rejects(run(g, { apply: true, sleep: async () => {} }), /did not add/);
  });
});

describe('create-ghl-fields: saves the current picklist first', () => {
  test('writes the current interest options to a JSON file before any change, in dry run too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghl-bk-'));
    const g = fakeGhl({ fields: baseFields() });
    const order = [];
    const realUpdate = g.updateCustomField;
    g.updateCustomField = async (...a) => { order.push(fs.readdirSync(dir).length ? 'file-existed' : 'no-file'); return realUpdate(...a); };
    const dry = await run(g, { apply: false, backupDir: dir });
    const saved = JSON.parse(fs.readFileSync(dry.backupFile, 'utf8'));
    assert.equal(saved.fieldId, FIELDS.INTEREST);
    assert.deepEqual(saved.options, CURRENT_INTEREST);
    await run(g, { apply: true, backupDir: dir, now: new Date('2030-01-01T00:00:00Z') });
    assert.deepEqual(order, ['file-existed']); // the backup predates the update call
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('create-ghl-fields: never creates a duplicate field', () => {
  test('a differently-spelled existing option (Event Photo / Video vs Event Photo/Video) is not added again', async () => {
    const fields = baseFields();
    fields[0].picklistOptions = fields[0].picklistOptions.filter((o) => o !== 'Legacy Staff Option');
    const g = fakeGhl({ fields });
    await run(g, { apply: true });
    const sent = g.state.updates[0].body.options;
    assert.equal(sent.filter((o) => /event photo/i.test(o)).length, 1);
    assert.deepEqual(sent.slice(-6), NEW_OPTIONS);
  });

  const LT_ID = 'sbTqxmTIflSJeviCeNnT';
  const withLeadType = () => [...baseFields(), { id: LT_ID, name: 'DMA Lead Type', dataType: 'SINGLE_OPTIONS', picklistOptions: ['New Business', 'Returning Client', 'Agency/Planner', 'Vendor/Referral Partner', 'Other'] }];
  const ATTR_NAMES = ['DMA gclid', 'DMA utm_source', 'DMA utm_medium', 'DMA utm_campaign', 'DMA utm_term', 'DMA utm_content', 'lead_channel', 'lead_origin', 'greeting'];

  test('Lead Type: the existing "DMA Lead Type" is reused and a new Lead Type is never created', async () => {
    const g = fakeGhl({ fields: withLeadType() });
    const lines = [];
    const r = await run(g, { apply: true, log: (l) => lines.push(l) });
    assert.ok(!g.state.created.some((d) => /lead type/i.test(d.name)));
    assert.deepEqual(r.existing.find((e) => e.name === 'Lead Type'), { name: 'Lead Type', id: LT_ID });
    assert.ok(lines.some((l) => l.includes(`REUSING "DMA Lead Type" (id=${LT_ID}`) && l.includes('GHL_FIELD_LEAD_TYPE_ID')));
    assert.ok(lines.some((l) => /differ from the app's lead types/.test(l)));
    const none = await run(fakeGhl({ fields: baseFields() }), { log: (l) => lines.push(l) });
    assert.ok(none.created.length === 0 && lines.some((l) => /expected the existing "DMA Lead Type"/.test(l)));
  });

  test('standard / attribution name conflicts are created as "DMA <name>" (dry run reports them too)', async () => {
    const dry = [];
    const g0 = fakeGhl({ fields: withLeadType() });
    await run(g0, { log: (l) => dry.push(l) });
    assert.equal(g0.state.created.length, 0);
    ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((k) => {
      assert.ok(dry.some((l) => l.includes(`"${k}" conflicts with a GHL standard field -> using "DMA ${k}"`)), k);
      assert.ok(dry.some((l) => l.startsWith(`WOULD CREATE "DMA ${k}"`)), k);
    });
    assert.ok(dry.some((l) => l.startsWith('WOULD CREATE "lead_channel"')) && dry.some((l) => l.startsWith('WOULD CREATE "lead_origin"')));
    assert.ok(!dry.some((l) => /WOULD CREATE "(gclid|utm_[a-z]+)"/.test(l)));
  });

  test('creates Guest Count and the attribution fields; a second run creates nothing', async () => {
    const g = fakeGhl({ fields: withLeadType() });
    const first = await run(g, { apply: true });
    assert.deepEqual(first.created.map((c) => c.name), ['Guest Count', ...ATTR_NAMES]);
    assert.ok(g.state.created.slice(1).every((d) => d.dataType === 'TEXT'));
    const second = await run(g, { apply: true });
    assert.equal(second.created.length, 0);
    assert.equal(g.state.created.length, 10);
    assert.deepEqual(second.existing.map((e) => e.name), ['Lead Type', 'Guest Count', ...ATTR_NAMES]);
  });

  test('an unknown standard-field conflict (HTTP 400) is retried once as "DMA <name>"', async () => {
    const g = fakeGhl({ fields: withLeadType() });
    const realCreate = g.createCustomField;
    g.createCustomField = async (def) => {
      if (def.name === 'lead_channel') { const e = new Error('GHL create-custom-field HTTP 400'); e.status = 400; e.body = '"lead_channel" conflicts with the standard field contact.lead_channel'; throw e; }
      return realCreate(def);
    };
    const r = await run(g, { apply: true });
    assert.ok(r.created.some((c) => c.name === 'DMA lead_channel'));
    assert.ok(!g.state.created.some((d) => d.name === 'lead_channel'));
  });

  test('a similar existing field blocks creation unless --allow-similar', async () => {
    const fields = [...withLeadType(), { id: 'sim', name: 'DMA lead_origin notes', dataType: 'TEXT' }];
    const g = fakeGhl({ fields });
    const r = await run(g, { apply: true });
    assert.ok(!g.state.created.some((d) => d.name === 'lead_origin'));
    assert.equal(r.similar[0].id, 'sim');
    await run(g, { apply: true, allowSimilar: true });
    assert.ok(g.state.created.some((d) => d.name === 'lead_origin'));
  });

  test('an existing field with the same name (any case/spacing) blocks creation and reports its id', async () => {
    const fields = [...withLeadType(), { id: 'gc1', name: '  guest   COUNT ', dataType: 'NUMERICAL' }, { id: 'g2', name: ' dma GCLID', dataType: 'TEXT' }];
    const g = fakeGhl({ fields });
    const r = await run(g, { apply: true });
    assert.ok(!g.state.created.some((d) => d.name === 'Guest Count' || /gclid/i.test(d.name)));
    assert.deepEqual(r.existing.slice(0, 3), [{ name: 'Lead Type', id: LT_ID }, { name: 'Guest Count', id: 'gc1' }, { name: 'DMA gclid', id: 'g2' }]);
  });

  test('a field created between the first listing and the create is not duplicated', async () => {
    const g = fakeGhl({ fields: baseFields() });
    const realList = g.listCustomFields;
    let calls = 0;
    g.listCustomFields = async () => {
      calls++;
      if (calls === 2) g.state.fields.push({ id: 'raced', name: 'Guest Count', dataType: 'NUMERICAL' }); // someone else creates it
      return realList();
    };
    const r = await run(g, { apply: true });
    assert.ok(!g.state.created.some((d) => d.name === 'Guest Count'));
    assert.ok(r.existing.some((e) => e.id === 'raced'));
  });

  test('an empty listing aborts instead of creating', async () => {
    const g = fakeGhl({ fields: [] });
    await assert.rejects(run(g, { apply: true }), /refusing to continue/);
    assert.equal(g.state.created.length, 0);
  });
});
