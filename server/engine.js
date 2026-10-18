// Corroboration engine. Spec: docs/BUILD_SPEC.md Section 4.
//
// Two layers:
//   scan layer   — counts per zone per 15-minute window vs the zone's hour-of-day baseline.
//                  Content-free: fires on every packet, including hangups and no-extract.
//   content layer — independence-weighted corroboration per zone+target; confidence score
//                   1 – 0.5^n (Sakaki-style, HEURISTIC, not calibrated); adjacent-zone
//                   spread; rungs: watch / ask / hand.
//
// Machine sources (telemetry) never reach "hand" on their own; human caller count
// is tracked separately from alarm activations (Palisades 906 ringers lesson).
import { config } from "./config.js";

const E = config.engine;

export class Engine {
  /**
   * @param {import('./store.js').Store} store
   * @param {{ adjacency?: Record<string, string[]> }} [opts]
   */
  constructor(store, { adjacency = {} } = {}) {
    this.store = store;
    this.adjacency = adjacency; // zone_id → [neighbour zone_ids]
  }

  /**
   * Ingest one packet into the engine: scan layer always runs; content layer
   * runs only when there is extractable content.
   * Always returns { incident, rung, reason } — even when no incident is created (spec §14).
   *
   * @param {object} packet      Validated packet from makePacket()
   * @param {{ triggers?: {hard:string[], soft:Array<{id,weight}>} }} [opts]
   */
  ingest(packet, { triggers = { hard: [], soft: [] } } = {}) {
    const s = this.store;
    packet.packet_id ||= s.nextId("pk");
    s.packets.push(packet);
    s.appendEvent({
      event_type: "packet_created",
      packet_id: packet.packet_id,
      call_id: packet.call_id,
      provenance: packet.provenance,
      actor: packet.source === "voice" ? "ai" : "device",
      payload_json: {
        zone_id: packet.zone_id,
        target: packet.target,
        source: packet.source,
        content_status: packet.content_status,
      },
    });

    this._scanLayer(packet);

    if (packet.content_status === "none" || packet.target === "unknown") {
      return { incident: null, rung: "watch", reason: "no extractable content; scan layer only" };
    }

    const incident = this._attach(packet);
    this._rescore(incident, packet, triggers);
    this._spread(incident, packet);
    s.save();
    return { incident, rung: incident.rung, reason: incident.last_reason };
  }

  // -------------------------------------------------------------------------
  // Scan layer: Poisson tail against the zone's hourly baseline
  // -------------------------------------------------------------------------
  _scanLayer(packet) {
    const s = this.store;
    const t = new Date(packet.received_at).getTime();
    const windowStart = new Date(Math.floor(t / E.scanWindowMs) * E.scanWindowMs).toISOString();

    let w = s.zoneWindows.find((x) => x.zone_id === packet.zone_id && x.window_start === windowStart);
    if (!w) {
      w = { zone_id: packet.zone_id, window_start: windowStart, n: 0, p_tail: null, flagged: false };
      s.zoneWindows.push(w);
    }
    w.n += 1;

    const hour = new Date(windowStart).getUTCHours();
    const base = s.baselines.find((b) => b.zone_id === packet.zone_id && b.hour === hour);
    const lambda = Math.max(base?.mean_per_15min ?? 0.05, 1e-3);
    w.p_tail = poissonTail(w.n, lambda);

    const wasFlagged = w.flagged;
    w.flagged = w.n >= E.scanMinCount && w.p_tail < E.scanPoissonTail;
    if (w.flagged && !wasFlagged) {
      s.appendEvent({
        event_type: "scan_flagged",
        packet_id: packet.packet_id,
        actor: "system",
        provenance: packet.provenance,
        payload_json: { zone_id: w.zone_id, window_start: w.window_start, n: w.n, p_tail: w.p_tail, lambda },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Content layer — step 1: attach packet to existing or new incident
  // -------------------------------------------------------------------------
  _attach(packet) {
    const s = this.store;
    const now = new Date(packet.received_at).getTime();

    // Reuse an open incident for the same zone+target within the keep-alive window
    let inc = s.incidents.find(
      (i) =>
        i.zone_id === packet.zone_id &&
        i.target === packet.target &&
        !i.closed_at &&
        now - new Date(i.last_packet_at).getTime() <= E.keepAliveMs
    );

    if (!inc) {
      inc = {
        id: s.nextId("inc"),
        zone_id: packet.zone_id,
        target: packet.target,
        opened_at: packet.received_at,
        last_packet_at: packet.received_at,
        closed_at: null,
        rung: "watch",
        score: 0,
        independent_count: 0,
        packet_ids: [],
        keys: {},                          // independence_key → count of packets from that key
        max_severity: 0,
        spread_linked_incident_id: null,
        summary_text: null,
        summary_evidence_count: 0,
        last_reason: "opened",
        triggers: [],
        soft_weight: 0,
      };
      s.incidents.push(inc);
      s.appendEvent({
        event_type: "incident_opened",
        incident_id: inc.id,
        packet_id: packet.packet_id,
        actor: "system",
        provenance: packet.provenance,
        payload_json: { zone_id: inc.zone_id, target: inc.target },
      });
    }

    inc.packet_ids.push(packet.packet_id);
    inc.last_packet_at = packet.received_at;
    packet.incident_id = inc.id;

    // Machine sources (alarm activations, telemetry) are tracked separately and
    // never counted as independent human callers — Palisades 906-ringer lesson.
    if (E.machineSources.includes(packet.source)) {
      inc.machine_count = (inc.machine_count || 0) + 1;
    } else {
      inc.keys[packet.independence_key] = (inc.keys[packet.independence_key] || 0) + 1;
      if (inc.keys[packet.independence_key] > 1) inc.repeat_count = (inc.repeat_count || 0) + 1;
    }

    inc.independent_count = Object.keys(inc.keys).length;
    inc.max_severity = Math.max(inc.max_severity, packet.severity);
    return inc;
  }

  // -------------------------------------------------------------------------
  // Content layer — step 2: recalculate score and rung
  // -------------------------------------------------------------------------
  _rescore(inc, packet, triggers) {
    const s = this.store;
    const n = inc.independent_count;

    // Confidence score: 1 – pFalse^n (Sakaki 2010; labelled HEURISTIC throughout)
    let score = n > 0 ? 1 - Math.pow(E.pFalse, n) : 0;

    // Single-caller cap: one key may lift score at most to singleCallerCap × handScore
    if (n <= 1) score = Math.min(score, E.singleCallerCap * E.handScore);

    // Soft triggers add a small fractional bonus
    inc.soft_weight = (inc.soft_weight || 0) +
      (triggers.soft || []).reduce((a, t) => a + t.weight, 0) * 0.05;
    score = Math.min(1, score + inc.soft_weight);

    inc.score = Number(score.toFixed(3));
    inc.triggers = Array.from(new Set([...(inc.triggers || []), ...(triggers.hard || [])]));

    // Determine rung — later conditions override earlier ones
    let rung = "watch";
    let reason = `independent sources ${n}, confidence ${inc.score}`;

    if (E.highConsequenceTargets.includes(inc.target) && n >= 1) {
      rung = "ask";
      reason = `high-consequence target ${inc.target} with ${n} source(s)`;
    }
    if (n >= E.askIndependentCount) {
      rung = "ask";
      reason = `${n} independent sources within window`;
    }
    if (n >= E.handIndependentCount || inc.score >= E.handScore) {
      rung = "hand";
      reason = `${n} independent sources, confidence ${inc.score}`;
    }
    if (inc.triggers.length) {
      rung = "hand";
      reason = `hard trigger: ${inc.triggers.join(", ")}`;
    }

    if (rung !== inc.rung) {
      s.appendEvent({
        event_type: "rung_changed",
        incident_id: inc.id,
        packet_id: packet.packet_id,
        actor: "system",
        provenance: packet.provenance,
        payload_json: { from: inc.rung, to: rung, reason },
      });
      inc.rung = rung;
    }
    inc.last_reason = reason;

    if (inc.triggers.length) {
      s.appendEvent({
        event_type: "trigger_fired",
        incident_id: inc.id,
        packet_id: packet.packet_id,
        actor: "system",
        provenance: packet.provenance,
        payload_json: { triggers: inc.triggers },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Content layer — step 3: adjacent-zone spread
  // -------------------------------------------------------------------------
  _spread(inc, packet) {
    const s = this.store;
    const neighbors = this.adjacency[inc.zone_id] || [];
    const now = new Date(packet.received_at).getTime();

    const linked = s.incidents.find(
      (o) =>
        o.id !== inc.id &&
        !o.closed_at &&
        o.target === inc.target &&
        neighbors.includes(o.zone_id) &&
        now - new Date(o.last_packet_at).getTime() <= E.mergeWindowMs
    );

    if (linked && !inc.spread_linked_incident_id) {
      inc.spread_linked_incident_id = linked.id;
      linked.spread_linked_incident_id ||= inc.id;
      s.appendEvent({
        event_type: "incident_spread",
        incident_id: inc.id,
        packet_id: packet.packet_id,
        actor: "system",
        provenance: packet.provenance,
        payload_json: {
          linked_incident_id: linked.id,
          zones: [inc.zone_id, linked.zone_id],
          target: inc.target,
        },
      });
      if (inc.rung === "watch") {
        inc.rung = "ask";
        inc.last_reason = `spread across adjacent zones ${inc.zone_id} and ${linked.zone_id}`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Board view: ranked list of open incidents
  // -------------------------------------------------------------------------
  ranked() {
    const order = { hand: 0, ask: 1, watch: 2 };
    return this.store.incidents
      .filter((i) => !i.closed_at)
      .sort(
        (a, b) =>
          order[a.rung] - order[b.rung] ||
          b.score - a.score ||
          new Date(b.last_packet_at) - new Date(a.last_packet_at)
      )
      .map((i) => ({
        ...i,
        keys: undefined,          // strip independence keys from the board view
        trend: this._trend(i),
        first_report_at: i.opened_at,
        score_label: "confidence score (heuristic)",
        ...this._relay(i),
      }));
  }

  // Relay summary for the board (node hearings and self-report triage)
  _relay(inc) {
    const ps = this.store.packets.filter((p) => p.incident_id === inc.id);
    const withNodes = ps
      .filter((p) => (p.heard_by || []).length)
      .sort((a, b) => b.heard_by.length - a.heard_by.length)[0];
    const held = ps.filter((p) => p.reported_severity);
    return {
      heard_by: withNodes?.heard_by || [],
      hearings: withNodes?.hearings || [],
      picked_up: withNodes?.picked_up || null,
      delivered_at: withNodes?.delivered_at || null,
      approx_area: withNodes?.approx_area || null,
      self_reported_held: held.length,
      triage_note: held[0]?.triage_note || null,
    };
  }

  // Rising trend when ≥2 packets in the last 10 minutes
  _trend(inc) {
    const ps = this.store.packets
      .filter((p) => p.incident_id === inc.id)
      .map((p) => new Date(p.received_at).getTime())
      .sort();
    if (ps.length < 2) return "flat";
    const recent = ps.filter((t) => t > Date.now() - 10 * 60 * 1000).length;
    return recent >= 2 ? "rising" : "flat";
  }

  // -------------------------------------------------------------------------
  // Close an incident
  // -------------------------------------------------------------------------
  /**
   * Close an incident.
   * High-severity incidents (max_severity ≥ 4) close only by a supervisor (spec §14).
   * Automation (system/ai) never closes incidents (spec §14).
   */
  close(incidentId, actor, reason) {
    const inc = this.store.incidents.find((i) => i.id === incidentId);
    if (!inc) return { ok: false, status: 404 };
    if (inc.max_severity >= 4 && actor !== "supervisor")
      return { ok: false, status: 403, error: "high-severity incidents close only by a supervisor" };
    if (actor === "system" || actor === "ai")
      return { ok: false, status: 403, error: "automation never closes incidents" };

    inc.closed_at = new Date().toISOString();
    this.store.appendEvent({
      event_type: "incident_closed",
      incident_id: inc.id,
      actor,
      provenance: "firsthand",
      payload_json: { reason },
    });
    this.store.save();
    return { ok: true };
  }
}

// -------------------------------------------------------------------------
// Poisson tail probability: P(X ≥ n) for Poisson(lambda)
// Used by the scan layer to compare inbound rate against the zone baseline.
// -------------------------------------------------------------------------
export function poissonTail(n, lambda) {
  let p = Math.exp(-lambda), cdf = 0;
  for (let k = 0; k < n; k++) { cdf += p; p *= lambda / (k + 1); }
  return Math.max(0, Math.min(1, 1 - cdf));
}
