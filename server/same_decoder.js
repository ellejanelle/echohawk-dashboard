// NOAA SAME (Specific Area Message Encoding) header parser and event-action mapper.
// SAME format: ZCZC-ORG-EVENT-PSSCCC+TTTT-JJJHHMM-LLLLLLLL/NWS-
// Multiple location codes separated by '-' are supported.

/**
 * Parse a NOAA SAME EAS header string.
 *
 * @param {string} text
 * @returns {{ originator, event, locations, durationMinutes, issued, sender } | { error: string }}
 */
export function parseSameHeader(text) {
  if (typeof text !== "string" || !text.startsWith("ZCZC-")) {
    return { error: "missing ZCZC prefix" };
  }

  // Strip trailing whitespace / EOM trailers, remove the leading "ZCZC-"
  const body = text.replace(/\s+$/, "").slice("ZCZC-".length);

  // Split on '-'; minimum fields: ORG, EVENT, one-or-more locations+duration, JJJHHMM, SENDER
  const parts = body.split("-");
  if (parts.length < 5) return { error: "bad field count" };

  const originator = parts[0];
  const event      = parts[1];

  // The duration is attached to the last location code with '+', e.g. "006037+0100"
  const plusIdx = parts.findIndex((p) => p.includes("+"));
  if (plusIdx < 2) return { error: "bad field count" };

  // Collect all location codes (index 2 through plusIdx, inclusive)
  const locationParts = parts.slice(2, plusIdx + 1);
  const lastLoc = locationParts[locationParts.length - 1];
  const plusPos  = lastLoc.indexOf("+");
  const lastLocCode = lastLoc.slice(0, plusPos);
  const durationStr = lastLoc.slice(plusPos + 1);

  const locations = [...locationParts.slice(0, -1), lastLocCode];

  // All location codes must be exactly 6 decimal digits
  for (const loc of locations) {
    if (!/^\d{6}$/.test(loc)) return { error: "non-numeric location" };
  }

  // Duration must be exactly 4 decimal digits (HHMM)
  if (!/^\d{4}$/.test(durationStr)) return { error: "non-numeric time" };
  const durationHH = parseInt(durationStr.slice(0, 2), 10);
  const durationMM = parseInt(durationStr.slice(2, 4), 10);
  const durationMinutes = durationHH * 60 + durationMM;

  // Issued timestamp: JJJHHMM (7 decimal digits)
  const issuedStr = parts[plusIdx + 1];
  if (!issuedStr || !/^\d{7}$/.test(issuedStr)) return { error: "non-numeric time" };
  const dayOfYear = parseInt(issuedStr.slice(0, 3), 10);
  const hhmm      = issuedStr.slice(3, 7);

  // Sender: everything after JJJHHMM joined back (the field may contain '-' internally)
  const senderParts = parts.slice(plusIdx + 2);
  // Drop trailing empty part from a trailing '-'
  while (senderParts.length && senderParts[senderParts.length - 1] === "") senderParts.pop();
  if (!senderParts.length) return { error: "bad field count" };
  const sender = senderParts.join("-");

  return {
    originator,
    event,
    locations,
    durationMinutes,
    issued: { dayOfYear, hhmm },
    sender,
  };
}

/**
 * Map a SAME event code to a human-readable action name.
 *
 * @param {string} code  Two-or-three-letter SAME event code
 * @returns {string}
 */
export function actionForEvent(code) {
  const MAP = {
    SPW: "shelter_in_place",
    EVI: "evacuate",
    CEM: "info_only",
    RWT: "info_only",
    FFW: "info_only",
    TOR: "info_only",
  };
  return MAP[code] ?? "info_only";
}
