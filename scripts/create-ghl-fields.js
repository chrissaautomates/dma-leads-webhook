// One-time GHL schema setup for the standard lead shape. DRY-RUN by default:
// prints what it would do and changes nothing. Pass --apply to write.
//
//   node scripts/create-ghl-fields.js            # show the plan
//   node scripts/create-ghl-fields.js --apply    # do it
//
// Needs GHL_API_KEY + GHL_LOCATION_ID (e.g. `railway run node ...`). It:
//   1. creates "Guest Count" (NUMERICAL) — only if no contact field with that name exists
//   2. creates "Lead Type" (SINGLE_OPTIONS, FIELD_OPTIONS.LEAD_TYPE) — same check
//   3. adds Glambot / Robotics / LED Tunnel / DMA Engage / Holiday / Headshot to the
//      DMA_Interest picklist
// then prints the new field IDs to set as GHL_FIELD_GUEST_COUNT_ID /
// GHL_FIELD_LEAD_TYPE_ID on Railway.
//
// SAFETY
//  - Duplicates: the name check is repeated against a FRESH listing immediately
//    before each create, and the run refuses outright if GHL returns no fields at
//    all (a failed/empty listing must never look like "nothing exists yet").
//  - Picklist updates: whether PUT /customFields/{id} replaces or merges `options`
//    has NOT been verified against the live API, so the script assumes it REPLACES:
//    it sends the FULL list (current options first, in order, then the new ones),
//    never just the additions. After an --apply update it re-reads the field and, if
//    any original option is missing, immediately re-sends the full list and fails
//    loudly.
//  - The custom-field endpoints (ghl-client.js) are unexercised from this project:
//    read the dry-run output first and watch the first --apply.

const { FIELDS, FIELD_OPTIONS } = require('../ghl-canonical');

const optionLabel = (o) => (typeof o === 'string' ? o : (o && (o.label || o.value || o.name)) || '');
const optionsOf = (f) => (f.picklistOptions || f.options || []).map(optionLabel).filter(Boolean);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const hasOption = (list, o) => list.some((x) => norm(x) === norm(o));

// Full option list to send: every current option (original order and spelling),
// then each wanted option not already there (case/spacing-insensitive).
function mergeOptions(current, wanted) {
  const merged = [...current];
  wanted.forEach((o) => { if (!hasOption(merged, o)) merged.push(o); });
  return merged;
}

// deps: { listCustomFields, createCustomField, updateCustomField }
async function run(deps, { apply = false, log = () => {} } = {}) {
  const result = { created: [], updated: null, existing: [] };
  const existing = await deps.listCustomFields();
  if (!existing.length) {
    throw new Error('GHL returned no custom fields — refusing to continue (an empty listing could create duplicates)');
  }
  log(`${apply ? 'APPLY' : 'DRY-RUN'} — ${existing.length} contact custom fields found\n`);

  const findByName = (fields, name) => fields.find((f) => norm(f.name) === norm(name));

  for (const [name, env, def] of [
    ['Guest Count', 'GHL_FIELD_GUEST_COUNT_ID', { name: 'Guest Count', dataType: 'NUMERICAL' }],
    ['Lead Type', 'GHL_FIELD_LEAD_TYPE_ID', { name: 'Lead Type', dataType: 'SINGLE_OPTIONS', options: FIELD_OPTIONS.LEAD_TYPE }],
  ]) {
    const found = findByName(existing, name);
    if (found) {
      result.existing.push({ name, id: found.id });
      log(`"${name}" already exists: id=${found.id}  -> set ${env}=${found.id}`);
      continue;
    }
    log(`WOULD CREATE "${name}": ${JSON.stringify(def)}`);
    if (!apply) continue;
    // Fresh check right before creating, so nothing created meanwhile is duplicated.
    const again = findByName(await deps.listCustomFields(), name);
    if (again) {
      result.existing.push({ name, id: again.id });
      log(`  "${name}" appeared since the first listing: id=${again.id}  -> set ${env}=${again.id} (not created)`);
      continue;
    }
    const created = await deps.createCustomField(def);
    result.created.push({ name, id: created.id });
    log(`  created id=${created.id}  -> set ${env}=${created.id}`);
  }

  const interest = existing.find((f) => f.id === FIELDS.INTEREST);
  if (!interest) { log(`\nDMA_Interest (${FIELDS.INTEREST}) not found — cannot update its options`); return result; }
  const have = optionsOf(interest);
  const missing = FIELD_OPTIONS.INTEREST.filter((o) => !hasOption(have, o));
  if (!missing.length) { log('\nDMA_Interest already has every option'); return result; }
  const next = mergeOptions(have, FIELD_OPTIONS.INTEREST);
  log(`\nWOULD ADD to DMA_Interest: ${missing.join(', ')}  (sending the full list: ${have.length} existing + ${missing.length} new = ${next.length})`);
  result.updated = { id: interest.id, before: have, sent: next };
  if (!apply) return result;

  await deps.updateCustomField(interest.id, { name: interest.name, options: next });
  const after = optionsOf((await deps.listCustomFields()).find((f) => f.id === interest.id) || {});
  const lost = have.filter((o) => !hasOption(after, o));
  const notAdded = missing.filter((o) => !hasOption(after, o));
  if (lost.length) {
    log(`  !! ORIGINAL OPTIONS MISSING after update: ${lost.join(', ')} — re-sending the full list`);
    await deps.updateCustomField(interest.id, { name: interest.name, options: next });
    throw new Error(`DMA_Interest update dropped existing options (${lost.join(', ')}); the full list was re-sent — check the field in GHL`);
  }
  if (notAdded.length) throw new Error(`DMA_Interest update did not add: ${notAdded.join(', ')}`);
  log(`  updated: ${after.length} options, all ${have.length} originals preserved`);
  return result;
}

if (require.main === module) {
  const ghl = require('../ghl-client');
  run(ghl, { apply: process.argv.includes('--apply'), log: console.log })
    .then(() => { if (!process.argv.includes('--apply')) console.log('\nDry run only. Re-run with --apply to write.'); })
    .catch((err) => { console.error(err.message, err.body || ''); process.exit(1); });
}

module.exports = { run, mergeOptions, optionsOf };
