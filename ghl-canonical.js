// Canonical DMA Events GHL field IDs and tag names — single source of truth
// for the Wix -> GHL lead intake endpoint (and anything else that needs
// them later). Every ID here is copied verbatim from docs/ghl-canonical-fields.md
// and docs/ghl-canonical-tags.md (Phase 1 of the DMA GHL project) — nothing
// in this file is guessed. If those docs ever change, update here too.
//
// DMA Events location: WWFoHKH8wu9QTuAKBUzK

const LOCATION_ID = 'WWFoHKH8wu9QTuAKBUzK';

// Custom field IDs. Comment on each notes which docs table it came from and
// its GHL data type, so a future edit here can't drift from the source of
// truth without someone noticing the type no longer matches.
const FIELDS = {
  // --- Part 1: existing fields selected as canonical (not created) ---
  LEAD_SOURCE: 'oo9XwoYxesQGKY5RSmmr', // "DMA Lead Source", SINGLE_OPTIONS
  EVENT_DATE: 'b3B7PHuZnNY8CE637eSZ', // "Event Date", DATE
  EVENT_TYPE: '2RrUkfZp9fxlxJACtbqt', // "Event Type", SINGLE_OPTIONS
  INTEREST: '85yxy9C2z42HfOv36Pif', // "DMA_Interest", MULTIPLE_OPTIONS
  LEAD_SCORE: 'yF3w9QsksBuReeauCq4x', // "Lead Score", NUMERICAL
  OWNER: 'uqFqlFzXExP1rpyRCgFY', // "Owner", SINGLE_OPTIONS — not written by this webhook (see wix-lead-intake.js)

  // --- Part 2: new fields created in Phase 1 Step 2 ---
  CAMPAIGN: 'bPznSu7NvOYe7fWMXM4K', // "DMA Campaign", TEXT
  BUDGET_RANGE: 'LYlXmuBDiHd9upyJ3Saz', // "DMA Budget Range", SINGLE_OPTIONS
  LEAD_STATUS: 'hRXXDKAyi7R8ojbX3aGL', // "DMA Lead Status", SINGLE_OPTIONS
  LAST_ACTIVITY: 'CGG7sfEOdmOLfcDKl9Ro', // "DMA Last Activity", TEXT
  MARKETING_CONSENT: 'sLslU39MFpmNYlrWkErB', // "DMA Marketing Consent", SINGLE_OPTIONS
};

// Legacy/duplicate field IDs that must NEVER be written by this webhook —
// listed here (not just in docs) so a future edit can grep for a field ID
// against this array before adding a new write path. See
// docs/ghl-canonical-fields.md "Duplicate Field(s)" column for the full
// reasoning per field.
const FORBIDDEN_LEGACY_FIELD_IDS = new Set([
  'FGDQK0aBYgVoPmvFyemn', // Type Of Source (duplicate of DMA Lead Source)
  'DFtwWj0zRnQaBgDZN4MD', // Lead Source Detail (duplicate of DMA Lead Source)
  'OaCwkSUOMfzLgDymhaKL', // Date Of Event (duplicate of Event Date)
  '3b1Abl0twqcrUni4XJbr', '4dMfdvPGI2wnwxZFABT5', 'ezdlAGGn3O1afhQTYY84', // Event Date duplicates
  'M1HMO8uzVxaPXie8zLHj', 'gCai58ZmSq7zCEGD71A4', 'bm1yD6QLgfGlchkdh1iD', 'uD6Nxx2gfXpEtZkd7553', // Event Type duplicates
  'nAvlORGXODoqxmIqRAvR', 'L3dV7BwNMjBVsELiimcc', 'xH0nNkZGq4xsu8uood4E', 'FkGyyIk2xzXRr7UTm7i7', 'vabUppT6UFnJxw6zEHXX', '64BNhipRNXBZG6l15UCY', // DMA_Interest duplicates
  'NBadH7HqIWt2jR4BY1vC', 'fyymaXOiYtObPOyrr1tN', 'sSd1cqPRvg3BSPy6Hk9Y', 'Xkb30hYPuaPpL9v0WX9p', // Owner duplicates
]);

// Valid picklist options, copied verbatim from the docs. Used to validate a
// Wix-submitted value before ever sending it to GHL — a SINGLE_OPTIONS field
// sent a value outside this list either silently fails to render correctly
// in the GHL UI or (worse) gets stored as an orphan string no report/filter
// will ever match. When a Wix value doesn't match, wix-lead-intake.js does
// NOT set the field — it preserves the raw value in the contact note
// instead, so nothing is silently lost, just not force-fit into a field
// that doesn't support it.
const FIELD_OPTIONS = {
  // "Website" (the literal value named in the DMA lead-intake spec) is not
  // one of this field's real options — "Website Form" is the closest valid
  // canonical value and is what this webhook actually writes. Documented
  // here and in wix-lead-intake.js rather than silently substituted.
  LEAD_SOURCE: [
    'Website Form', 'Chatbot', 'GHL Form', 'Google Ad', 'Meta Ad', 'LinkedIn',
    'Calendly', 'Email Reply', 'Manual Entry', 'Referral', 'Event Lead',
    'Trade Show Outreach', 'Check Cherry', 'Unknown', 'Attendee',
  ],
  EVENT_TYPE: ['Corporate', 'Gala', 'Product Launch', 'Trade Show', 'Brand Activation', 'Others'],
  BUDGET_RANGE: ['Under $2,500', '$2,500-$5,000', '$5,000-$10,000', '$10,000-$25,000', '$25,000+', 'Unknown'],
  LEAD_STATUS: [
    'New', 'Nurture', 'Engaged', 'Hot', 'Sales Priority', 'Sales Contacted',
    'Discovery Booked', 'Discovery Completed', 'Proposal Sent', 'Proposal Follow-Up',
    'Verbal Yes', 'Contract / Deposit', 'Won', 'Not Ready', 'Lost',
  ],
  MARKETING_CONSENT: ['Yes', 'No', 'Unknown'],
  // DMA_Interest's real option list. Note several canonical interest TAGS
  // (Glambot, Robotics, DMA Engage, Holiday, Headshot, LED Tunnel) have no
  // matching option here — see INTEREST_MAP in wix-lead-intake.js for how
  // that gap is handled (tag still applied, field falls back to "Other").
  INTEREST: [
    'Hat Bar', 'AI Photo Booth', 'Trading Cards', '360 Booth', 'Laser Engraving',
    'Mosaic', 'Trade Show Engagement', 'Event Photo/Video', 'Other',
  ],
};

// Canonical tags. Values are the ACTUAL tag name strings GHL's API expects
// (POST /contacts/{id}/tags takes tag name strings, not tag IDs) — for a
// REUSED legacy tag, this is the legacy tag's own name, not the "lead-new"
// / "lead-hot" style concept label used in the DMA docs to describe it. Get
// this wrong and the webhook silently creates a brand new tag that doesn't
// match anything in docs/ghl-canonical-tags.md instead of reusing the real
// canonical one. Cross-checked against that doc's "Canonical Tag" vs.
// "Reused or New" columns for every single entry below.
const TAGS = {
  SOURCE_WEBSITE: 'source-website', // NEW, exact name
  LEAD_NEW: 'new-lead', // REUSED — canonical pointer's real name, NOT the literal string "lead-new"

  LEAD_TYPE: {
    'event planner': 'planners', // REUSED
    agency: 'agency', // REUSED
    corporate: 'corporate', // REUSED
    conference: 'type-conference', // NEW, exact name
    brand: 'type-brand', // NEW, exact name
    venue: 'type-venue', // NEW, exact name
    social: 'type-social', // NEW, exact name
  },
};

// Interest input -> { tag, fieldOption }. `tag` is null where no canonical
// interest-* tag exists for that concept (none defined in Phase 1's
// taxonomy) but the value is still a real DMA_Interest option. `fieldOption`
// is 'Other' where the reverse is true (a canonical tag exists but
// DMA_Interest's picklist has no matching option) — flagged inline. Lookup
// keys are lowercased; wix-lead-intake.js normalizes input the same way.
const INTEREST_MAP = {
  'ai photo booth': { tag: 'interest-ai', fieldOption: 'AI Photo Booth' },
  ai: { tag: 'interest-ai', fieldOption: 'AI Photo Booth' },
  glambot: { tag: 'interest-glambot', fieldOption: 'Other' }, // no matching DMA_Interest option
  'trading cards': { tag: 'trading cards', fieldOption: 'Trading Cards' }, // REUSED legacy tag name
  robotics: { tag: 'interest-robotics', fieldOption: 'Other' }, // no matching DMA_Interest option
  'dma engage': { tag: 'interest-dma-engage', fieldOption: 'Other' }, // no matching DMA_Interest option
  holiday: { tag: 'interest-holiday', fieldOption: 'Other' }, // no matching DMA_Interest option
  headshot: { tag: 'interest-headshot', fieldOption: 'Other' }, // no matching DMA_Interest option
  mosaic: { tag: 'interest-mosaic', fieldOption: 'Mosaic' },
  'led tunnel': { tag: 'interest-led-tunnel', fieldOption: 'Other' }, // no matching DMA_Interest option
  // Real DMA_Interest options with no canonical interest-* tag defined in
  // Phase 1 at all — field gets set, no tag applied.
  'hat bar': { tag: null, fieldOption: 'Hat Bar' },
  '360 booth': { tag: null, fieldOption: '360 Booth' },
  'laser engraving': { tag: null, fieldOption: 'Laser Engraving' },
  'trade show engagement': { tag: null, fieldOption: 'Trade Show Engagement' },
  'event photo/video': { tag: null, fieldOption: 'Event Photo/Video' },
  'event photo': { tag: null, fieldOption: 'Event Photo/Video' },
};

module.exports = {
  LOCATION_ID,
  FIELDS,
  FIELD_OPTIONS,
  FORBIDDEN_LEGACY_FIELD_IDS,
  TAGS,
  INTEREST_MAP,
};
