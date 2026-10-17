// First-name hygiene for the GHL contact push. A placeholder is never a real
// name: it becomes '' so GHL gets an empty first name instead of a fake one.
// Same list and behavior as the helper in ghl-campaign-scheduler and
// email-category-scheduler.

const PLACEHOLDER_FIRST_NAMES = new Set(['prospect', 'friend', 'there', 'valued', 'n/a', 'null', 'undefined']);

function cleanFirstName(value) {
  if (value === null || value === undefined) return '';
  const name = String(value).trim();
  return PLACEHOLDER_FIRST_NAMES.has(name.toLowerCase()) ? '' : name;
}

module.exports = { PLACEHOLDER_FIRST_NAMES, cleanFirstName };
