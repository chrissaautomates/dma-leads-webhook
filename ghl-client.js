// Thin GHL (LeadConnector) API client, scoped to exactly what the lead push
// (ghl-push.js) needs: find-by-email/phone, get, create, update, add tags,
// add a note. Uses the same timeout-wrapped fetch() pattern already
// established in sync.js (fetchWithTimeout) rather than a new HTTP library —
// this project has no axios/node-fetch dependency and there's no reason to
// add one for four simple JSON calls.
//
// Required env vars:
//   GHL_API_KEY       - already used by sync.js's syncGHL(); reused here
//   GHL_LOCATION_ID    - already used by sync.js's syncGHL(); reused here
//
// Version header note: GHL's API uses a different `Version` header value per
// resource family — sync.js already shows this directly (conversations/
// search uses 'v3', conversations/{id}/messages uses '2021-04-15'). The
// Contacts endpoints used here (create/update/tags/notes/duplicate-search)
// use '2021-07-28', GHL's documented standard version for the Contacts API
// family. This has NOT been verified against a live call from this project
// (doing so would mean hitting real DMA Events data, out of scope for this
// implementation task) — verify with one real dry-run call before the first
// production deploy, the same way every other unverified integration in
// this codebase (see sync.js's Google Ads / Wix Forms comments) got its
// first real-payload confirmation.

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const CONTACTS_API_VERSION = '2021-07-28';
const DEFAULT_TIMEOUT_MS = 15000;

// Same shape/reasoning as sync.js's fetchWithTimeout: reads the body inside
// the same abort window, so a slow-streaming (not just slow-to-start)
// response can't hang past the timeout. Duplicated here rather than
// imported from sync.js on purpose — sync.js is a polling/import module,
// this is a request-serving one; keeping them decoupled means a future
// change to one's retry/timeout behavior doesn't silently affect the other.
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: () => text, json: () => JSON.parse(text) };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class GhlApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GhlApiError';
    this.status = status;
    this.body = body;
  }
}

function getConfig() {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey) throw new Error('GHL_API_KEY is not set');
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');
  return { apiKey, locationId };
}

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: CONTACTS_API_VERSION,
    'content-type': 'application/json',
  };
}

// GET /contacts/search/duplicate — the endpoint purpose-built for exactly
// this check, and the one that respects the location's own "Allow
// Duplicate Contact" setting (DMA Events has this OFF, prioritizing email
// then phone — see docs/ghl-current-state.md) rather than reimplementing
// that priority logic here. Pass email when available; only fall back to
// phone when there's no email at all, matching the same priority.
async function findDuplicateContact({ email, phone }) {
  const { apiKey, locationId } = getConfig();
  const params = new URLSearchParams({ locationId });
  if (email) params.set('email', email);
  else if (phone) params.set('number', phone);
  else return null; // caller's own validation should prevent this, but never guess

  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/search/duplicate?${params.toString()}`, {
    headers: authHeaders(apiKey),
  });
  if (res.status === 404) return null; // no match — GHL returns 404 for "not found" on this endpoint
  if (!res.ok) throw new GhlApiError(`GHL duplicate-search HTTP ${res.status}`, res.status, res.text().slice(0, 500));
  const body = await res.json();
  // Response shape per GHL docs: { contact: {...} } when found.
  return (body && body.contact) || null;
}

// GET /contacts/{id} — the full contact, including tags and customFields.
// Used to decide whether an existing contact is already "advanced" (see
// ghl-push.js) before any new-lead tag is applied. Not assumed to be part of
// the duplicate-search response, whose exact shape has never been verified
// against a live call.
async function getContact(contactId) {
  const { apiKey } = getConfig();
  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) throw new GhlApiError(`GHL get-contact HTTP ${res.status}`, res.status, res.text().slice(0, 500));
  const body = await res.json();
  return body.contact || null;
}

// Returns { contact, created: true }. If GHL rejects the create as a
// duplicate (allowDuplicateContact is OFF for this location, so this is a
// real possibility under a race — e.g. a double-submit from Wix, or this
// lookup and the actual create landing a few hundred ms apart from another
// concurrent request for the same lead), falls back to re-searching and
// updating instead of surfacing a raw error — this is what makes the
// "duplicate submission" scenario safe without needing a distributed lock.
async function createContact(fields) {
  const { apiKey, locationId } = getConfig();
  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ ...fields, locationId }),
  });
  if (res.ok) {
    const body = await res.json();
    return { contact: body.contact, created: true };
  }

  const bodyText = res.text();
  const looksLikeDuplicate = res.status === 400 && /duplicat/i.test(bodyText);
  if (looksLikeDuplicate && (fields.email || fields.phone)) {
    const existing = await findDuplicateContact({ email: fields.email, phone: fields.phone });
    if (existing) return { contact: existing, created: false };
  }
  throw new GhlApiError(`GHL create-contact HTTP ${res.status}`, res.status, bodyText.slice(0, 500));
}

// Partial update — GHL's PUT /contacts/{id} treats omitted top-level keys
// as "leave unchanged" (matches create-contact's own optional/nullable
// field schema) and merges customFields by id rather than replacing the
// whole array (confirmed behavior, see docs/ghl-phase3-results.md Step 6 —
// setting one custom field via update-contact left every previously-set
// field on the contact untouched). ghl-lead-plan.js relies on exactly
// this: it only ever includes fields Wix actually supplied.
async function updateContact(contactId, fields) {
  const { apiKey } = getConfig();
  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: authHeaders(apiKey),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new GhlApiError(`GHL update-contact HTTP ${res.status}`, res.status, res.text().slice(0, 500));
  const body = await res.json();
  return body.contact;
}

// Adds tags without touching any tag already on the contact (POST .../tags
// is additive, unlike PUT /contacts/{id}'s own `tags` field, which would
// replace the whole tag list — deliberately not used here for that reason).
async function addTags(contactId, tags) {
  if (!tags || !tags.length) return;
  const { apiKey } = getConfig();
  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new GhlApiError(`GHL add-tags HTTP ${res.status}`, res.status, res.text().slice(0, 500));
}

// Free-text message preservation — a note, not a field, per the task's own
// "structured Wix form values are authoritative; do not use AI to infer
// event fields from the message in this version" instruction.
async function createNote(contactId, body) {
  if (!body) return;
  const { apiKey } = getConfig();
  const res = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new GhlApiError(`GHL create-note HTTP ${res.status}`, res.status, res.text().slice(0, 500));
}

module.exports = {
  GhlApiError,
  findDuplicateContact,
  getContact,
  createContact,
  updateContact,
  addTags,
  createNote,
};
