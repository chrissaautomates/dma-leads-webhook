// One-time GHL schema setup for the standard lead shape. DRY-RUN by default:
// prints what it would do and changes nothing. Pass --apply to write.
//
//   node scripts/create-ghl-fields.js            # show the plan
//   node scripts/create-ghl-fields.js --apply    # do it
//
// Needs GHL_API_KEY + GHL_LOCATION_ID (e.g. `railway run node ...`). It:
//   1. creates "Guest Count" (NUMERICAL) if no contact field with that name exists
//   2. creates "Lead Type" (SINGLE_OPTIONS, FIELD_OPTIONS.LEAD_TYPE) if missing
//   3. adds Glambot / Robotics / LED Tunnel / DMA Engage / Holiday / Headshot to
//      the DMA_Interest picklist (existing options are kept, never removed)
// then prints the new field IDs to set as GHL_FIELD_GUEST_COUNT_ID /
// GHL_FIELD_LEAD_TYPE_ID on Railway. The plan skips those two fields until set.
//
// The custom-field endpoints (ghl-client.js) have not been exercised from this
// project yet — review the dry-run output, then watch the first --apply.

const ghl = require('../ghl-client');
const { FIELDS, FIELD_OPTIONS } = require('../ghl-canonical');

const apply = process.argv.includes('--apply');
const optionsOf = (f) => f.picklistOptions || f.options || [];

async function main() {
  const existing = await ghl.listCustomFields();
  const byName = (name) => existing.find((f) => String(f.name).trim().toLowerCase() === name.toLowerCase());
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} — ${existing.length} contact custom fields found\n`);

  for (const [name, env, def] of [
    ['Guest Count', 'GHL_FIELD_GUEST_COUNT_ID', { name: 'Guest Count', dataType: 'NUMERICAL' }],
    ['Lead Type', 'GHL_FIELD_LEAD_TYPE_ID', { name: 'Lead Type', dataType: 'SINGLE_OPTIONS', options: FIELD_OPTIONS.LEAD_TYPE }],
  ]) {
    const found = byName(name);
    if (found) { console.log(`"${name}" already exists: id=${found.id}  -> set ${env}=${found.id}`); continue; }
    console.log(`WOULD CREATE "${name}": ${JSON.stringify(def)}`);
    if (apply) {
      const created = await ghl.createCustomField(def);
      console.log(`  created id=${created.id}  -> set ${env}=${created.id}`);
    }
  }

  const interest = existing.find((f) => f.id === FIELDS.INTEREST);
  if (!interest) { console.log(`\nDMA_Interest (${FIELDS.INTEREST}) not found — cannot update its options`); return; }
  const have = optionsOf(interest);
  const missing = FIELD_OPTIONS.INTEREST.filter((o) => !have.some((h) => h.toLowerCase() === o.toLowerCase()));
  if (!missing.length) { console.log('\nDMA_Interest already has every option'); return; }
  const next = [...have, ...missing];
  console.log(`\nWOULD ADD to DMA_Interest: ${missing.join(', ')}  (keeping ${have.length} existing)`);
  if (apply) {
    await ghl.updateCustomField(interest.id, { name: interest.name, options: next });
    console.log('  updated');
  }
}

main().catch((err) => { console.error(err.message, err.body || ''); process.exit(1); });
