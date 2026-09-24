// Page code (Velo). Attach this to the DMA lead form's Submit button
// ($w('#submitButton') below — rename to match your actual element ID).
//
// This file is PUBLIC — it ships to every visitor's browser exactly as
// written. It must never contain the webhook secret, a GHL API key, or any
// other credential. It only ever calls the backend function in
// backend.jsw, which is where the real secret lives and the real HTTP call
// to our lead-intake service happens.
//
// Field IDs below ($w('#firstNameInput') etc.) are placeholders — replace
// with your actual Wix Editor element IDs. The keys on the object passed to
// submitDmaLead() are what matters: they must match the field names
// wix-lead-intake.js expects (see docs/ghl-canonical-fields.md and the
// INPUT section of the Wix intake spec) — firstName, lastName, email,
// phone, company, eventDate, eventType, guestCount, city, interest,
// secondaryInterest, budgetRange, message, campaign, leadType,
// marketingConsent, pageUrl, utmSource, utmMedium, utmCampaign.

import { submitDmaLead } from 'backend/leadIntake.jsw';
import wixLocation from 'wix-location';
import wixWindow from 'wix-window';

$w.onReady(function () {
  $w('#submitButton').onClick(async () => {
    $w('#submitButton').disable();
    $w('#formErrorText').hide();

    const formData = {
      firstName: $w('#firstNameInput').value,
      lastName: $w('#lastNameInput').value,
      email: $w('#emailInput').value,
      phone: $w('#phoneInput').value,
      company: $w('#companyInput').value,
      eventDate: $w('#eventDateInput').value, // Wix date picker — value is an ISO date already
      eventType: $w('#eventTypeDropdown').value, // e.g. "Corporate", "Gala", "Trade Show"
      guestCount: $w('#guestCountInput').value,
      city: $w('#cityInput').value,
      interest: $w('#interestDropdown').value, // e.g. "AI Photo Booth", "Trading Cards"
      secondaryInterest: $w('#secondaryInterestDropdown').value,
      budgetRange: $w('#budgetRangeDropdown').value, // must match a real DMA Budget Range option to be captured structurally
      message: $w('#messageInput').value,
      campaign: '', // set this if the page itself represents one specific campaign (e.g. a CMEE 2026 landing page)
      leadType: $w('#leadTypeDropdown').value, // e.g. "Event Planner", "Agency", "Corporate", "Conference"
      // Only send an explicit yes/no when the visitor actually answered a
      // real consent checkbox — never default this to true just because
      // the form was submitted. See docs/wix-ghl-existing-contact-behavior.md
      // and wix-lead-intake.js for why "not answered" and "no" are treated
      // differently upstream.
      marketingConsent: $w('#marketingConsentCheckbox').checked ? 'yes' : '',
      pageUrl: wixLocation.url,
      utmSource: wixWindow.getCurrentUTMParams ? (wixWindow.getCurrentUTMParams().utm_source || '') : '',
      utmMedium: wixWindow.getCurrentUTMParams ? (wixWindow.getCurrentUTMParams().utm_medium || '') : '',
      utmCampaign: wixWindow.getCurrentUTMParams ? (wixWindow.getCurrentUTMParams().utm_campaign || '') : '',
    };

    try {
      const result = await submitDmaLead(formData);
      $w('#formSuccessText').show();
      $w('#leadForm').collapse(); // or navigate to a thank-you page, per your site's design
      console.log('DMA lead submitted:', result.contactId, result.created ? '(new)' : '(existing)');
    } catch (err) {
      $w('#formErrorText').text = "Something went wrong submitting your request — please try again or email us directly.";
      $w('#formErrorText').show();
      console.error('DMA lead submission failed:', err.message);
    } finally {
      $w('#submitButton').enable();
    }
  });
});
