// DMA & BuyAndRentRobots — Leads webhook receiver + admin page
//
// Receives lead/status events from GHL and CheckCherry and writes them
// straight into a local SQLite database on this service's own Railway
// Volume. A password-protected /admin page lets Christine/Richard view,
// edit, and manually add leads.
//
// This replaces the earlier design that round-tripped every lead through a
// Google Apps Script Web App bound to a spreadsheet. That path turned out to
// be unreliable in practice: Apps Script would run the request successfully
// server-side, but the HTTP response back to the caller was inconsistent,
// and every code change needed a manual copy/paste + redeploy cycle in the
// Apps Script editor. A local database with its own admin UI has no such
// moving parts.
//
// Required environment variables (set these in Railway):
//   WEBHOOK_SECRET   - shared secret; incoming lead requests must send it
//                       back as the x-webhook-secret header
//   ADMIN_PASSWORD   - password for the /admin page (Basic Auth)
//   ADMIN_USER       - username for /admin (optional, defaults to "admin")
//   DB_PATH          - where to store the SQLite file (optional, defaults
//                       to /data/leads.db — requires a Railway Volume
//                       mounted at /data)

const express = require('express');
const { upsertLead } = require('./db');
const adminRouter = require('./admin');
const { runFullSync } = require('./sync');
const { validateWixPayload, buildLeadPlan } = require('./wix-lead-intake');
const ghl = require('./ghl-client');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

function checkSecret(req, res) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return true; // no secret configured — allow (not recommended)
  if (req.get('x-webhook-secret') !== expected) {
    res.status(401).json({ ok: false, error: 'bad secret' });
    return false;
  }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/admin', adminRouter);

// Single normalized endpoint. Point both GHL and CheckCherry webhook actions
// here; use the "source" field (or a query param ?source=ghl) to tag origin.
app.post('/webhook/lead', (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const data = { ...req.body };
    if (!data.source && req.query.source) data.source = req.query.source;

    const result = upsertLead(data);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function normalizeFieldKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Google's user_column_data is [{ column_name, column_id, string_value }, ...]
// — not a flat object. Flattens it into { normalizedKey: value }, keyed by
// column_name (falling back to column_id when column_name is absent), with
// keys normalized (lowercased, non-alphanumeric stripped) so "Full Name",
// "full_name", and the standard column_id "FULL_NAME" all land on the same
// key regardless of which one a given form actually sends.
function flattenUserColumnData(userColumnData) {
  const flat = {};
  (userColumnData || []).forEach((item) => {
    if (!item) return;
    const key = normalizeFieldKey(item.column_name || item.column_id);
    if (!key) return;
    flat[key] = item.string_value != null ? String(item.string_value) : '';
  });
  return flat;
}

// Same flexible-alias approach as sync.js's pick() for the CSV sources —
// Google's exact field names for this form aren't confirmed yet (see the
// raw-payload logging in the route below), so this tries known standard
// Google Ads Lead Form column_id values alongside plausible human-readable
// labels rather than assuming one exact name.
function pickGoogleField(flat, aliases) {
  for (const alias of aliases) {
    if (flat[alias]) return flat[alias];
  }
  return '';
}

function mapGoogleAdsLead(userColumnData) {
  const flat = flattenUserColumnData(userColumnData);

  const name = pickGoogleField(flat, ['fullname', 'name'])
    || [flat.firstname, flat.lastname].filter(Boolean).join(' ');

  const location = [flat.city, flat.region || flat.state, flat.postalcode || flat.zipcode]
    .filter(Boolean).join(', ') || pickGoogleField(flat, ['location']);

  return {
    source: 'Google Ads',
    name: name || '',
    email: pickGoogleField(flat, ['email', 'workemail', 'emailaddress']),
    phone: pickGoogleField(flat, ['phonenumber', 'workphonenumber', 'phone', 'mobilephone']),
    company: pickGoogleField(flat, ['companyname', 'company', 'businessname', 'organization']),
    location,
    interest: pickGoogleField(flat, ['interest', 'message', 'whatareyouinterestedin', 'request', 'jobtitle']),
  };
}

const GOOGLE_ADS_RAW_LOG_LIMIT = 10;
let googleAdsRawLogCount = 0;

// Google Ads' Lead Form webhook integration — a different contract from
// /webhook/lead, kept separate rather than merged. Google treats a non-200
// or slow/hanging response as a failure and retries, so this always
// responds 200 {} once the google_key check passes (errors are logged, not
// surfaced as a non-200, to avoid a retry storm).
app.post('/webhook/google-ads-lead', (req, res) => {
  const expectedKey = process.env.GOOGLE_ADS_WEBHOOK_KEY;
  if (!expectedKey || req.body.google_key !== expectedKey) {
    return res.status(401).json({ ok: false, error: 'bad google_key' });
  }

  const isTest = req.body.is_test === true || req.body.is_test === 'true';
  if (isTest) {
    // Google's "Send Test Data" button — don't clutter the dashboard with it.
    return res.status(200).json({});
  }

  // Field mapping above is unverified against a real payload (Google's exact
  // column_name/column_id values for this form aren't documented). Log the
  // raw data for the first several real submissions so it can be checked.
  googleAdsRawLogCount += 1;
  if (googleAdsRawLogCount <= GOOGLE_ADS_RAW_LOG_LIMIT) {
    console.log(
      `Google Ads lead webhook raw user_column_data (#${googleAdsRawLogCount}):`,
      JSON.stringify(req.body.user_column_data)
    );
  }

  try {
    upsertLead(mapGoogleAdsLead(req.body.user_column_data));
  } catch (err) {
    console.error('Google Ads lead webhook: upsert failed', err);
  }

  res.status(200).json({});
});

// ---------------------------------------------------------------------------
// Wix -> GHL lead intake
//
// Receives a lead submitted through the Wix public website form (relayed by
// a Wix backend .jsw function — see wix-example/), and creates/updates the
// matching DMA Events GHL contact with canonical fields/tags only.
//
// Deliberately does NOT create an opportunity, create a sales task, send
// email/SMS, or enroll the contact into any workflow — Workflow 1 ("New
// Lead- Send Services - Email Sequence", d79a76bd-c787-425a-8588-2b3594714d64)
// already creates the primary DMA opportunity and kicks off the rest of the
// intake automation the moment this endpoint creates a new contact. See
// docs/wix-ghl-existing-contact-behavior.md for what happens (and doesn't
// happen) automatically when this endpoint updates an EXISTING contact
// instead — that automation does not re-fire on an update.
//
// Required env var: WIX_WEBHOOK_SECRET — the Wix backend .jsw function must
// send this back as `Authorization: Bearer <secret>` (a plain custom header
// also works, see checkWixSecret below). Distinct from WEBHOOK_SECRET
// (used by /webhook/lead above) since these are separate integrations with
// separate callers — rotating one should never require rotating the other.

function checkWixSecret(req, res) {
  const expected = process.env.WIX_WEBHOOK_SECRET;
  if (!expected) {
    res.status(500).json({ success: false, error: 'server not configured' });
    return false; // unlike /webhook/lead's optional secret, this endpoint
    // writes real GHL data and must never run unauthenticated — refuse to
    // start accepting requests rather than silently allow every caller
    // through, the way a missing WEBHOOK_SECRET does above.
  }
  const authHeader = req.get('authorization') || '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const provided = (bearerMatch && bearerMatch[1]) || req.get('x-wix-webhook-secret') || '';
  if (provided !== expected) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

// Minimal in-memory fixed-window rate limiter — no new dependency for what
// is, at expected volume, a handful of requests per minute from one known
// caller (the Wix backend). Not suitable for a multi-instance deployment
// (each instance would track its own window independently), which is fine
// at this project's current single-instance Railway scale; revisit with a
// shared store (e.g. the existing SQLite db, or Redis) if that changes.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitState = new Map(); // ip -> { count, windowStart }

function checkRateLimit(req, res) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitState.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({ success: false, error: 'rate limit exceeded' });
    return false;
  }
  return true;
}

app.post('/api/leads/wix', async (req, res) => {
  if (!checkWixSecret(req, res)) return;
  if (!checkRateLimit(req, res)) return;

  const body = req.body || {};
  const { valid, errors } = validateWixPayload(body);
  if (!valid) {
    return res.status(400).json({ success: false, error: errors.join('; ') });
  }

  try {
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();

    const existing = await ghl.findDuplicateContact({ email, phone });
    const isNewContact = !existing;
    const plan = buildLeadPlan(body, { isNewContact });

    if (plan.warnings.length) {
      // Never exposed in the response — internal visibility only, and
      // logging never includes the webhook secret or GHL API key (neither
      // is ever passed to this function in the first place).
      console.log(`wix lead intake: ${plan.warnings.length} unmapped value(s) for ${email || phone}:`, plan.warnings);
    }

    let contact;
    let created;
    if (existing) {
      contact = await ghl.updateContact(existing.id, { ...plan.contactFields, customFields: plan.customFields });
      created = false;
    } else {
      const result = await ghl.createContact({ ...plan.contactFields, customFields: plan.customFields });
      contact = result.contact;
      created = result.created;
    }

    if (plan.tags.length) await ghl.addTags(contact.id, plan.tags);
    if (plan.note) await ghl.createNote(contact.id, plan.note);

    res.json({ success: true, contactId: contact.id, created });
  } catch (err) {
    // err.message may include an HTTP status/short body snippet (see
    // ghl-client.js's GhlApiError) but never a header value — the secret
    // and API key are only ever read from process.env, never threaded
    // through anything that ends up in an error message.
    console.error('wix lead intake failed:', err.message);
    res.status(502).json({ success: false, error: 'lead intake failed' });
  }
});

// Only actually listen and start the background sync scheduler when this
// file is run directly (`node server.js` / `npm start`) — not when it's
// `require()`'d, which is exactly what the automated tests do (via
// supertest-less direct app import) to exercise /api/leads/wix without
// opening a real port, starting the 15-minute sync loop, or making any of
// the outbound calls runFullSync() would otherwise kick off 5 seconds after
// every test run. `require.main === module` is Node's standard way to tell
// the two apart; behavior for the normal `npm start` path is unchanged.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Leads webhook listening on ${PORT}`));

  // runFullSync() was previously never actually wired up to run anywhere in
  // production — no automatic trigger here, and no manual trigger in the
  // admin UI either. It only ever ran via local `railway run` invocations
  // against local/scratch DB_PATH files during development, which is why the
  // real database on the Railway volume stayed empty despite those runs
  // looking successful. This is what actually triggers it against the real
  // database now.
  const SYNC_INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES) || 15) * 60 * 1000;
  setTimeout(() => {
    runFullSync().then((status) => console.log('Initial sync:', JSON.stringify(status)));
  }, 5000);
  setInterval(() => {
    runFullSync().then((status) => console.log('Scheduled sync:', JSON.stringify(status)));
  }, SYNC_INTERVAL_MS);
}

module.exports = app;
