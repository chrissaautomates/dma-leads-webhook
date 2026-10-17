// One-time GHL schema setup for the standard lead shape. DRY-RUN by default:
// prints what it would do and changes nothing. Pass --apply to write.
//
//   node scripts/create-ghl-fields.js            # show the plan
//   node scripts/create-ghl-fields.js --apply    # do it
//   (--allow-similar: create a field even if one with a similar name exists)
//
// (Also creates the 8 attribution TEXT fields: gclid, utm_source, utm_medium, utm_campaign, utm_term,
// utm_content, lead_channel, lead_origin -> GHL_FIELD_GCLID_ID, GHL_FIELD_UTM_SOURCE_ID, ... . Names that
// collide with a GHL standard / attribution field are created as "DMA <name>", e.g. "DMA gclid".)
// Needs GHL_API_KEY + GHL_LOCATION_ID. This is the one script that works with
// `railway run` (`railway run node scripts/create-ghl-fields.js`): it only talks to
// GHL and never opens the leads database, so it doesn't need to run in the container.
// It:
//   1. creates "Guest Count" (NUMERICAL) — only if no contact field with that name exists
//   2. REUSES the existing "DMA Lead Type" field (never creates a Lead Type)
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
//  - Before anything else (dry run included) the current DMA_Interest options are
//    saved to ghl-backups/interest-options-<timestamp>.json (git-ignored), so the
//    list can be restored by hand if GHL ever mangles it.
//  - The custom-field endpoints (ghl-client.js) are unexercised from this project:
//    read the dry-run output first and watch the first --apply.

const fs = require('fs');
const path = require('path');
const { FIELDS, FIELD_OPTIONS } = require('../ghl-canonical');

const ATTRIBUTION_FIELD_DEFS = ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'lead_channel', 'lead_origin'];

// The existing "DMA Lead Type" field is REUSED; a new "Lead Type" field is never created.
const REUSE_LEAD_TYPE = { name: 'Lead Type', id: 'sbTqxmTIflSJeviCeNnT', env: 'GHL_FIELD_LEAD_TYPE_ID', existingName: 'DMA Lead Type' };
const GUEST_COUNT_ID = 'b82mrRP4Koh6LT2Wij3V';

// Names GHL reserves for STANDARD contact fields and the attribution (UTM / click-id) fields. A custom
// field with one of these names is rejected (live: "gclid" -> HTTP 400 "conflicts with the standard
// field contact.gclid"), and the contacts API cannot set the standard ones (the create/update body has
// no gclid / attribution members), so a conflicting field is created as "DMA <name>" instead. This list
// is our best knowledge of GHL's names, not an official one: a 400 conflict on create also falls back to
// the "DMA " name (see run()).
const STANDARD_FIELD_NAMES = [
  // contact
  'first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'company_name', 'address1', 'city', 'state',
  'postal_code', 'country', 'website', 'timezone', 'date_of_birth', 'source', 'tags', 'assigned_to', 'dnd',
  // attribution (attributionSource / lastAttributionSource)
  'gclid', 'fbclid', 'msclkid', 'ttclid', 'fbc', 'fbp', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'utm_keyword', 'utm_id', 'utm_session_source', 'session_source', 'medium', 'medium_id', 'campaign',
  'campaign_id', 'ad_group_id', 'ad_id', 'referrer', 'referrer_url', 'url', 'user_agent', 'ip', 'ga_client_id',
];
const stdKey = (n) => String(n || '').trim().toLowerCase().replace(/^contact\./, '').replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
const STANDARD_KEYS = new Set(STANDARD_FIELD_NAMES.map(stdKey).concat(STANDARD_FIELD_NAMES.map((n) => stdKey(n).replace(/_/g, ''))));
function standardConflict(name) {
  const k = stdKey(name);
  return STANDARD_KEYS.has(k) || STANDARD_KEYS.has(k.replace(/_/g, ''));
}
const dmaName = (name) => (/^dma\s/i.test(name) ? name : `DMA ${name}`);

const optionLabel = (o) => (typeof o === 'string' ? o : (o && (o.label || o.value || o.name)) || '');
const optionsOf = (f) => (f.picklistOptions || f.options || []).map(optionLabel).filter(Boolean);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
// Option comparison ignores ALL whitespace, so "Event Photo / Video" == "Event Photo/Video".
const optKey = (s) => norm(s).replace(/\s/g, '');
const hasOption = (list, o) => list.some((x) => optKey(x) === optKey(o));

// Full option list to send: every current option (original order and spelling),
// then each wanted option not already there (case/spacing-insensitive).
function mergeOptions(current, wanted) {
  const merged = [...current];
  wanted.forEach((o) => { if (!hasOption(merged, o)) merged.push(o); });
  return merged;
}

// deps: { listCustomFields, createCustomField, updateCustomField }
async function run(deps, { apply = false, allowSimilar = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, backupDir = process.env.GHL_BACKUP_DIR || path.join(__dirname, '..', 'ghl-backups'), now = new Date() } = {}) {
  const result = { created: [], updated: null, existing: [], backupFile: null };
  const existing = await deps.listCustomFields();
  if (!existing.length) {
    throw new Error('GHL returned no custom fields — refusing to continue (an empty listing could create duplicates)');
  }
  log(`${apply ? 'APPLY' : 'DRY-RUN'} — ${existing.length} contact custom fields found\n`);

  // Save the current interest options FIRST, whatever happens next.
  const interestNow = existing.find((f) => f.id === FIELDS.INTEREST);
  if (interestNow) {
    fs.mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, `interest-options-${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.json`);
    fs.writeFileSync(file, JSON.stringify({ fieldId: interestNow.id, name: interestNow.name, savedAt: now.toISOString(), options: optionsOf(interestNow), raw: interestNow.picklistOptions || interestNow.options || [] }, null, 2));
    result.backupFile = file;
    log(`saved current DMA_Interest options (${optionsOf(interestNow).length}) to ${file}\n`);
  }

  const findByName = (fields, name) => fields.find((f) => norm(f.name) === norm(name));
  // A field whose name merely CONTAINS ours ("DMA Lead Type" vs "Lead Type") is a
  // probable duplicate in spirit: never create over it unless --allow-similar.
  const findSimilar = (fields, name) => fields.find((f) => norm(f.name) !== norm(name) && (norm(f.name).includes(norm(name)) || norm(name).includes(norm(f.name))));

  // Lead Type: REUSE the existing "DMA Lead Type" field (never create a new one).
  const lt = existing.find((f) => f.id === REUSE_LEAD_TYPE.id);
  if (!lt) log(`!! expected the existing "${REUSE_LEAD_TYPE.existingName}" field (id=${REUSE_LEAD_TYPE.id}) was not found in GHL`);
  else {
    result.existing.push({ name: REUSE_LEAD_TYPE.name, id: lt.id });
    log(`"Lead Type": REUSING "${lt.name}" (id=${lt.id}, ${lt.dataType}) -> set ${REUSE_LEAD_TYPE.env}=${lt.id}`);
    log(`  !! its options [${optionsOf(lt).join(' | ')}] differ from the app's lead types [${FIELD_OPTIONS.LEAD_TYPE.join(' | ')}]; the app writes its own values, so leave ${REUSE_LEAD_TYPE.env} UNSET until a mapping is decided (lead-type tags still work without it)`);
  }

  const guest = findByName(existing, 'Guest Count');
  if (guest) {
    result.existing.push({ name: 'Guest Count', id: guest.id });
    log(`"Guest Count" already exists: id=${guest.id}  -> set GHL_FIELD_GUEST_COUNT_ID=${guest.id}${guest.id === GUEST_COUNT_ID ? '' : `   !! expected ${GUEST_COUNT_ID}`}`);
  } else {
    log(`WOULD CREATE "Guest Count": {"name":"Guest Count","dataType":"NUMERICAL"}`);
    if (apply) {
      const again = findByName(await deps.listCustomFields(), 'Guest Count');
      if (again) { result.existing.push({ name: 'Guest Count', id: again.id }); log(`  "Guest Count" appeared since the first listing: id=${again.id} (not created)`); } else {
        const created = await deps.createCustomField({ name: 'Guest Count', dataType: 'NUMERICAL' });
        result.created.push({ name: 'Guest Count', id: created.id });
        log(`  created id=${created.id}  -> set GHL_FIELD_GUEST_COUNT_ID=${created.id}`);
      }
    }
  }

  // Marketing attribution TEXT fields. A name that collides with a GHL standard / attribution field is
  // created as "DMA <name>" (the contacts API cannot write the standard fields).
  for (const key of ATTRIBUTION_FIELD_DEFS) {
    const env = `GHL_FIELD_${key.toUpperCase()}_ID`;
    const conflict = standardConflict(key);
    const name = conflict ? dmaName(key) : key;
    if (conflict) log(`"${key}" conflicts with a GHL standard field -> using "${name}"`);
    const found = findByName(existing, name);
    if (found) {
      result.existing.push({ name, id: found.id });
      log(`"${name}" already exists: id=${found.id}  -> set ${env}=${found.id}`);
      continue;
    }
    const similar = findSimilar(existing, name);
    if (similar && !allowSimilar) {
      result.similar = [...(result.similar || []), { name, existingName: similar.name, id: similar.id, dataType: similar.dataType, options: optionsOf(similar) }];
      log(`NOT CREATING "${name}": a similar field already exists — "${similar.name}" (id=${similar.id}, ${similar.dataType}). Decide whether to reuse it; pass --allow-similar to create "${name}" anyway.`);
      continue;
    }
    log(`WOULD CREATE "${name}": ${JSON.stringify({ name, dataType: 'TEXT' })}`);
    if (!apply) continue;
    // Fresh check right before creating, so nothing created meanwhile is duplicated.
    const again = findByName(await deps.listCustomFields(), name);
    if (again) {
      result.existing.push({ name, id: again.id });
      log(`  "${name}" appeared since the first listing: id=${again.id}  -> set ${env}=${again.id} (not created)`);
      continue;
    }
    let created;
    try {
      created = await deps.createCustomField({ name, dataType: 'TEXT' });
    } catch (err) {
      // GHL rejected the name as a standard-field conflict our list didn't know: retry once as "DMA <name>".
      if (err && err.status === 400 && /conflict|standard|reserved|already/i.test(`${err.body || ''} ${err.message}`) && name === key) {
        const alt = dmaName(key);
        log(`  GHL rejected "${name}" (${String(err.body || err.message).slice(0, 160)}) -> retrying as "${alt}"`);
        if (findByName(await deps.listCustomFields(), alt)) throw new Error(`"${alt}" already exists`);
        created = await deps.createCustomField({ name: alt, dataType: 'TEXT' });
        result.created.push({ name: alt, id: created.id });
        log(`  created id=${created.id}  -> set ${env}=${created.id}`);
        continue;
      }
      throw err;
    }
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
  // GHL's listing can lag a moment behind a write (seen live: an immediate re-read
  // still showed the old list), so poll before judging.
  let after = [];
  let lost = [];
  let notAdded = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    after = optionsOf((await deps.listCustomFields()).find((f) => f.id === interest.id) || {});
    lost = have.filter((o) => !hasOption(after, o));
    notAdded = missing.filter((o) => !hasOption(after, o));
    if (!lost.length && !notAdded.length) break;
    if (attempt < 6) await sleep(1500);
  }
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
  run(ghl, { apply: process.argv.includes('--apply'), allowSimilar: process.argv.includes('--allow-similar'), log: console.log })
    .then(() => { if (!process.argv.includes('--apply')) console.log('\nDry run only. Re-run with --apply to write.'); })
    .catch((err) => { console.error(err.message, err.body || ''); process.exit(1); });
}

module.exports = { run, mergeOptions, optionsOf, standardConflict, REUSE_LEAD_TYPE };
