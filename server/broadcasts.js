// Public alerts back to residents: the EchoHawk app (online), and phones / eHawk devices
// that only hear a chirp (offline).
//
// Authority model follows how LA works today: protective action decisions (evacuation orders
// and warnings, shelter in place) are made by law enforcement and fire, and the county's
// Office of Emergency Management sends the alert (Firehouse Jan 2025: alerts were decided
// "in coordination with" OEM, the Sheriff's Dept, county fire, and sent by OEM staff in
// Genasys ALERT). Therefore:
//   - Agency accounts (OEM, Sheriff, Fire, LAPD, LAFD, City EMD) draft and send;
//     protective actions need a second person from an agency to approve before going out
//     (the Jan 9 2025 countywide false alert is the reason).
//   - The EchoHawk supervisor can send an advisory (e.g. "we know about the water outage,
//     no need to call") and can REQUEST a protective action, which lands in the agency
//     queue as a draft; the supervisor cannot issue one.
//   - Everything is logged as events.
import { encodeFrame, toBase64 } from "../device/frame.js";
import { translate } from "./llm.js";
import { LANGUAGES } from "./languages.js";

export const AGENCIES = [
  { id: "lac-oem",  name: "LA County Office of Emergency Management" },
  { id: "lasd",     name: "LA County Sheriff's Department" },
  { id: "lacofd",   name: "LA County Fire Department" },
  { id: "lapd",     name: "Los Angeles Police Department" },
  { id: "lafd",     name: "Los Angeles Fire Department" },
  { id: "la-emd",   name: "City of LA Emergency Management Department" },
];

export const KINDS = {
  evacuation_order:   { label: "Evacuation order",   action: "evacuate",         severity: 5, protective: true,  lead: "Leave now." },
  evacuation_warning: { label: "Evacuation warning", action: "evacuate",         severity: 4, protective: true,  lead: "Get ready to leave." },
  shelter_in_place:   { label: "Shelter in place",   action: "shelter_in_place", severity: 4, protective: true,  lead: "Stay inside." },
  advisory:           { label: "Advisory",            action: "info_only",        severity: 2, protective: false, lead: "" },
  all_clear:          { label: "All clear",           action: "all_clear",        severity: 1, protective: false, lead: "" },
};

const now = () => new Date().toISOString();
const zoneNumber = (z) => { const m = String(z).match(/\d+/); return m ? Number(m[0]) : 0; };

export class Broadcasts {
  /**
   * @param {import('./store.js').Store} store
   * @param {{ frameKey: string }} opts
   */
  constructor(store, { frameKey }) {
    this.store = store;
    this.frameKey = frameKey;
    store.broadcasts ||= [];
  }

  list() {
    return [...this.store.broadcasts].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id) {
    return this.store.broadcasts.find((b) => b.id === id);
  }

  /**
   * Draft (or immediately send, for supervisor advisories) a broadcast.
   *
   * @param {object} body   { kind, zones, message, instructions?, hazard?, incident_id?, request?, ehawk? }
   * @param {{ role: "agency"|"supervisor", agency?: string, name?: string }} actor
   */
  create(body, actor) {
    const kind = KINDS[body.kind];
    if (!kind) return { ok: false, status: 400, error: `kind: ${Object.keys(KINDS).join(" | ")}` };

    const zones = (Array.isArray(body.zones) ? body.zones : [])
      .map(String)
      .filter(Boolean)
      .slice(0, 50);
    if (!zones.length) return { ok: false, status: 400, error: "pick at least one zone" };

    // Same ceiling as a 4G Wireless Emergency Alert
    const message = String(body.message || "").trim().slice(0, 360);
    if (!message) return { ok: false, status: 400, error: "message is required" };

    // Supervisors may only request protective actions, not issue them (spec §14)
    if (actor.role === "supervisor" && kind.protective && !body.request) {
      return { ok: false, status: 403, error: "Protective actions are issued by an agency. Send it as a request." };
    }

    const b = {
      id: this.store.nextId("bc"),
      kind: body.kind,
      label: kind.label,
      zones,
      message,
      instructions: String(body.instructions || "").slice(0, 360),
      hazard: String(body.hazard || "").slice(0, 60),
      incident_id: body.incident_id || null,
      status: actor.role === "supervisor" && kind.protective ? "requested" : "draft",
      created_at: now(),
      created_by: {
        role: actor.role,
        agency: actor.agency || "EchoHawk",
        name: actor.name || actor.role,
      },
      approved_by: null,
      sent_at: null,
      translations: {},
      frames: [],
      acks: { safe: 0, need_help: 0, left: 0 },
      channels: { app: true, ehawk: body.ehawk !== false },
    };

    this.store.broadcasts.push(b);
    this.store.appendEvent({
      event_type: b.status === "requested" ? "alert_requested" : "alert_drafted",
      actor: actor.role,
      provenance: "firsthand",
      payload_json: { id: b.id, kind: b.kind, zones, by: b.created_by },
    });

    // Supervisor advisories go straight out — they inform, they do not order anyone to move
    if (actor.role === "supervisor" && !kind.protective) {
      const out = this.send(b.id, actor, { selfApproved: true });
      if (!out.ok) this.store.broadcasts.splice(this.store.broadcasts.indexOf(b), 1);
      return out;
    }

    this.store.save();
    return { ok: true, broadcast: b };
  }

  /**
   * Send (approve) a drafted broadcast. Protective actions require a second person.
   *
   * @param {string} id   Broadcast id
   * @param {{ role: string, agency?: string, name?: string }} actor
   * @param {{ selfApproved?: boolean }} [opts]
   */
  send(id, actor, { selfApproved = false } = {}) {
    const b = this.get(id);
    if (!b) return { ok: false, status: 404, error: "not found" };
    if (b.status === "active" || b.status === "cancelled")
      return { ok: false, status: 409, error: `already ${b.status}` };

    const kind = KINDS[b.kind];

    if (kind.protective) {
      if (actor.role !== "agency")
        return { ok: false, status: 403, error: "Only an agency account can send a protective action." };
      // Two-person rule: the drafter cannot also approve (spec §14)
      if (
        !selfApproved &&
        actor.name &&
        b.created_by.role === "agency" &&
        actor.name.trim().toLowerCase() === String(b.created_by.name).trim().toLowerCase()
      ) {
        return {
          ok: false, status: 409,
          error: "A second person has to approve this. Ask a colleague to sign in and send it.",
        };
      }
    }

    // An all_clear lifts active broadcasts in those zones
    const lifts = b.kind === "all_clear"
      ? this.store.broadcasts.filter(
          (x) => x !== b && x.status === "active" && x.zones.some((z) => b.zones.includes(z))
        )
      : [];

    // Lifting a protective action is an agency decision
    if (lifts.some((x) => KINDS[x.kind].protective) && actor.role !== "agency") {
      return {
        ok: false, status: 403,
        error: "An evacuation or shelter order is active there. Only an agency can send the all clear.",
      };
    }

    for (const x of lifts) {
      x.status = "cancelled";
      x.cancelled_at = now();
      x.cancelled_by = {
        role: actor.role,
        agency: actor.agency || "EchoHawk",
        name: actor.name || actor.role,
        reason: "all clear",
      };
    }

    b.status = "active";
    b.sent_at = now();
    b.approved_by = {
      role: actor.role,
      agency: actor.agency || "EchoHawk",
      name: actor.name || actor.role,
    };

    // One signed 16-byte frame per zone for eHawk and offline phones
    b.frames = b.zones.map((z, k) => ({
      zone: z,
      b64: toBase64(
        encodeFrame(
          {
            type: "directive",
            zone: zoneNumber(z),
            target: "unknown",
            severity: kind.severity,
            action: kind.action,
            language: "en",
            sequence: (this.store.broadcasts.length * 16 + k) & 0xffff,
          },
          this.frameKey
        )
      ),
    }));

    this.store.appendEvent({
      event_type: "alert_sent",
      actor: actor.role,
      provenance: "firsthand",
      payload_json: { id: b.id, kind: b.kind, zones: b.zones, by: b.approved_by, drafted_by: b.created_by },
    });
    this.store.save();

    // English translation is live immediately; the rest fill in async
    const text = [kind.lead, b.message, b.instructions].filter(Boolean).join(" ");
    b.translations.en = { text, machine: false };
    this.translating = this.translateAll(b, text);

    return { ok: true, broadcast: b };
  }

  /** Translate the alert into all 15 supported languages in the background. */
  async translateAll(b, text) {
    await Promise.all(
      LANGUAGES.filter((l) => l.code !== "en").map(async (l) => {
        const tr = await Promise.race([
          translate(text, l.code, "en"),
          new Promise((r) => setTimeout(() => r(null), 8000)),
        ]).catch(() => null);
        if (tr && !tr.startsWith(`[${l.code}]`)) {
          b.translations[l.code] = { text: tr, machine: true };
        }
      })
    );
    this.store.appendEvent({
      event_type: "alert_translated",
      actor: "system",
      provenance: "firsthand",
      payload_json: { id: b.id, languages: Object.keys(b.translations) },
    });
    this.store.save();
  }

  /**
   * Cancel a broadcast. Protective-action cancellations are agency-only.
   */
  cancel(id, actor, reason = "") {
    const b = this.get(id);
    if (!b) return { ok: false, status: 404, error: "not found" };
    if (KINDS[b.kind].protective && actor.role !== "agency") {
      return { ok: false, status: 403, error: "Only an agency account can cancel a protective action." };
    }
    b.status = "cancelled";
    b.cancelled_at = now();
    b.cancelled_by = {
      role: actor.role,
      agency: actor.agency || "EchoHawk",
      name: actor.name || actor.role,
      reason: String(reason).slice(0, 200),
    };
    this.store.appendEvent({
      event_type: "alert_cancelled",
      actor: actor.role,
      provenance: "firsthand",
      payload_json: { id: b.id, reason },
    });
    this.store.save();
    return { ok: true, broadcast: b };
  }

  /**
   * Return active broadcasts for a zone in the resident's language.
   * Falls back to English when a translation is not yet available.
   */
  activeFor(zone, lang = "en") {
    return this.list()
      .filter((b) => b.status === "active" && (!zone || b.zones.includes(zone)))
      .map((b) => {
        const t = b.translations[lang] || b.translations.en || { text: b.message, machine: false };
        return {
          id: b.id,
          kind: b.kind,
          label: b.label,
          zones: b.zones,
          sent_at: b.sent_at,
          agency: b.approved_by?.agency || b.created_by.agency,
          text: t.text,
          language: b.translations[lang] ? lang : "en",
          machine_translated: !!t.machine,
          frames: b.frames
            .filter((f) => !zone || f.zone === zone)
            .map((f) => f.b64),
        };
      });
  }

  /**
   * Record a resident acknowledgement of an alert.
   * @param {string} id      Broadcast id
   * @param {"safe"|"need_help"|"left"} status
   */
  ack(id, status) {
    const b = this.get(id);
    if (!b) return { ok: false, status: 404, error: "not found" };
    if (!["safe", "need_help", "left"].includes(status))
      return { ok: false, status: 400, error: "status: safe | need_help | left" };
    b.acks[status] += 1;
    this.store.appendEvent({
      event_type: "alert_ack",
      actor: "resident",
      provenance: "firsthand",
      payload_json: { id, status },
    });
    this.store.save();
    return { ok: true, acks: b.acks };
  }
}
