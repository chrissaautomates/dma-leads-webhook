// Phone-number region check. Uses libphonenumber (not "starts with +1"): +1 is shared by
// Canada, the US and others, and libphonenumber tells them apart by area code. A number
// without a country code is read as Canadian by default (region 'CA'); the result is
// then judged on the number's ACTUAL country, so "212-555-1234" parses as US.
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// True only for a VALID number whose country is Canada.
function isCanadianPhone(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return false;
  const parsed = parsePhoneNumberFromString(text, 'CA');
  return !!parsed && parsed.isValid() && parsed.country === 'CA';
}

module.exports = { isCanadianPhone };
