// Packet schema and validation. Spec: docs/BUILD_SPEC.md Section 3.1.
// One canonical shape covers every source (voice, app, eHawk, telemetry, field_unit).
import { createHash } from "node:crypto";
import { config } from "./config.js";

export const SOURCES = ["voice", "app", "ehawk", "telemetry", "field_unit"];
export const TARGETS = [
  "power", "water", "gas", "power_line", "structure_fire", "wildfire",
  "road", "flood", "person", "vehicle", "alarm", "crime", "unknown",
];
export const ACTIONS = [
  "dispatch_ems", "dispatch_fire", "dispatch_police",
  "welfare_check", "info_only", "deflect_311", "unknown",
];
export const CONTENT_STATUS = ["extracted", "partial", "none"];
export const PROVENANCE = ["firsthand", "forwarded", "repeat_beacon", "simulated"];

/**
 * Derive an independence key from caller identifier + zone.
 * sha256(salt | identifier | zone_id) → 32 hex chars.
 * Repeat transmissions from the same device/number in the same zone reuse
 * the first packet's key, so they are never counted as independent corroboration.
 */
export function independenceKey(identifier, zoneId) {
  return createHash("sha256")
    .update(`${config.salt}|${identifier}|${zoneId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Validate and normalise a raw input object into a packet.
 * Always returns { packet, errors } — even when extraction failed (spec §14).
 * A packet is never deleted; errors are metadata, not a discard signal.
 */
export function makePacket(input) {
  const errors = [];

  const p = {
    packet_id: input.packet_id || null,
    source: input.source,
    received_at: new Date().toISOString(),
    observed_at: input.observed_at || new Date().toISOString(),
    zone_id: input.zone_id ?? "unknown",
    target: input.target ?? "unknown",
    // Default severity: 3 when target is known, 1 when totally unknown
    severity: Number.isInteger(input.severity)
      ? input.severity
      : input.target && input.target !== "unknown" ? 3 : 1,
    action: input.action ?? "unknown",
    independence_key: input.independence_key ||
      independenceKey(input.identifier || "anonymous", input.zone_id ?? "unknown"),
    content_status: input.content_status ||
      (input.target && input.target !== "unknown" ? "extracted" : "none"),
    language: input.language || "und",
    call_id: input.call_id || null,
    provenance: input.provenance || "firsthand",
    // tuesday | crisis — Twist 1 funding stream
    mode: input.mode || "tuesday",
  };

  if (!SOURCES.includes(p.source))
    errors.push(`source must be one of ${SOURCES.join(", ")}`);
  if (!TARGETS.includes(p.target))
    errors.push(`target must be one of ${TARGETS.join(", ")}`);
  if (!ACTIONS.includes(p.action))
    errors.push(`action must be one of ${ACTIONS.join(", ")}`);
  if (!(p.severity >= 1 && p.severity <= 5))
    errors.push("severity must be 1..5");
  if (!CONTENT_STATUS.includes(p.content_status))
    errors.push("bad content_status");
  if (!PROVENANCE.includes(p.provenance))
    errors.push("bad provenance");
  // zone_id must never be a street address (spec §14 non-negotiable)
  if (/\d+\s+\w+\s+(st|street|ave|avenue|blvd|rd|road|dr|drive)\b/i.test(String(p.zone_id)))
    errors.push("zone_id looks like a street address; use a zone");

  return { packet: p, errors };
}
