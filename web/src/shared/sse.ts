import { useEffect, useRef, useState } from "react";
import type { EventRow } from "./types";

export const ALL_EVENTS = [
  "packet_created", "incident_opened", "rung_changed", "trigger_fired", "incident_spread", "scan_flagged",
  "units_dispatched", "call_flagged", "transfer_started", "kit_shown", "callback_no_answer", "dispatcher_joined", "dispatcher_said",
  "incident_closed", "acknowledged_by_human", "turn_added", "turn_updated", "turn_translated", "language_detected", "call_started", "call_ended", "alert_sent", "alert_requested", "alert_cancelled", "alert_ack", "alert_translated", "alert_drafted", "unit_status", "incident_disposition",
  "unit_stop_added", "relay_heard", "report_picked_up", "demo_reset",
];

// Subscribe to the server's named SSE events. The handler ref keeps the latest closure without resubscribing.
export function useEvents(onEvent: (ev: EventRow) => void): "live" | "reconnecting" {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  const [state, setState] = useState<"live" | "reconnecting">("live");
  useEffect(() => {
    const es = new EventSource("/events/stream");
    es.onopen = () => setState("live");
    es.onerror = () => setState("reconnecting");
    // a supervisor reset the demo: every open screen starts clean
    es.addEventListener("demo_reset", () => setTimeout(() => location.reload(), 300));
    for (const t of ALL_EVENTS) es.addEventListener(t, (e) => { try { ref.current(JSON.parse((e as MessageEvent).data)); } catch (err) { console.warn("event", t, err); } });
    return () => es.close();
  }, []);
  return state;
}

// Poll plus debounce: call `soon()` from event handlers; also refreshes on an interval.
export function useRefresher(fn: () => Promise<void> | void, everyMs = 5000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { fnRef.current(); const t = setInterval(() => fnRef.current(), everyMs); return () => clearInterval(t); }, [everyMs]);
  return () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => fnRef.current(), 200); };
}
