// Action Kits and the Source Registry. Spec: docs/BUILD_SPEC.md Section 7.
// The AI picks which card to show; it never writes or edits one.
// Kits come verbatim from the catalog — the AI never invents or modifies them (spec §14).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const catalog = JSON.parse(
  readFileSync(join(here, "..", "kits", "catalog.json"), "utf8")
);
const byId = new Map(catalog.kits.map((k) => [k.kit_id, k]));

/** Look up a kit by id. Returns null if not in catalog. */
export function getKit(kitId) {
  return byId.get(kitId) || null;
}

/**
 * Show a kit card: validate, record in store, return verbatim script lines.
 * Returns { ok: false, status, error } when the kit is unknown or blocked.
 * The AI never orders evacuations, dispatches units, closes high-severity items,
 * or writes a medical step (spec §14); it only reads approved cards.
 *
 * @param {{ kit_id, zone_id, call_id, language }} opts
 * @param {import('./store.js').Store} store
 * @param {string} by  Actor label (default "ai")
 */
export function showKitCard({ kit_id, zone_id, call_id, language }, store, by = "ai") {
  const kit = getKit(kit_id);
  if (!kit) return { ok: false, status: 404, error: `kit ${kit_id} is not in the catalog` };

  // Medical kits pending review are gated to demo calls only
  const call = store.calls.find((c) => c.id === call_id);
  if (call?.resident_demo === false && kit.medical_review === "pending") {
    return { ok: false, status: 409, error: "Medical kit pending review; use a demo call for preview" };
  }

  // Serve the catalog's language variant if one exists; fall back to English
  const lang =
    language && language !== "en" && kit[`script_lines_${language}`] ? language : "en";
  const script_lines = lang === "en" ? kit.script_lines : kit[`script_lines_${lang}`];
  const display_steps =
    lang === "en" ? kit.display_steps : (kit[`display_steps_${lang}`] || kit.display_steps);

  // Record the show event and close any previously open kit for this call
  const row = {
    id: store.nextId("ks"),
    call_id: call_id || null,
    kit_id,
    shown_at: new Date().toISOString(),
    by,
    replaced_by_kit_id: null,
    closed_at: null,
  };
  if (call_id) {
    for (const old of store.kitShows) {
      if (old.call_id === call_id && !old.closed_at) {
        old.closed_at = row.shown_at;
        old.replaced_by_kit_id = kit_id;
      }
    }
  }
  store.kitShows.push(row);
  store.appendEvent({
    event_type: "kit_shown",
    call_id: call_id || null,
    actor: by,
    provenance: "firsthand",
    payload_json: {
      kit_id,
      zone_id: zone_id || null,
      review_status: kit.medical_review,
      language_served: lang,
    },
  });

  return {
    ok: true,
    kit_id,
    title: kit.title,
    script_lines,
    display_steps,
    language_served: lang,
    review_status: kit.medical_review,
    requires_human: kit.requires_human,
    source: {
      authority: kit.authority,
      reference_url: kit.reference_url,
      last_source_check: kit.last_source_check,
    },
  };
}

/**
 * Return the kit_id that should be auto-shown for a given set of extracted fields and triggers.
 * Returns null when no automatic kit applies.
 */
export function kitForFields(fields, triggers) {
  if (triggers?.hard?.includes("severe_bleeding")) return "EH-BLEED-001";
  if (fields?.target === "power" && (fields.severity || 1) <= 2) return "EH-LIGHT-001";
  return null;
}
