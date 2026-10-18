import { useState } from "react";
import type { Dispatched, Rung, Unit } from "./types";
import { RUNG_LABEL, UNITS } from "./labels";
import { hms } from "./time";

export function RungChip({ rung, machine }: { rung?: Rung | null; machine?: boolean }) {
  if (machine) return <span className="rung machine">Alarms only</span>;
  if (!rung) return null;
  return <span className={`rung ${rung}`}>{RUNG_LABEL[rung]}</span>;
}

// One-tap deploy. Suggested services are highlighted; sent ones turn green and stay that way.
export function DeployBar({ dispatched = [], suggested, onSend, withCallback = true, keys = false, size = "md" }: {
  dispatched?: Dispatched[]; suggested: Unit[]; onSend: (u: Unit) => Promise<boolean>; withCallback?: boolean; keys?: boolean; size?: "sm" | "md" | "lg";
}) {
  const [busy, setBusy] = useState<Unit | null>(null);
  const [failed, setFailed] = useState<Unit | null>(null);
  const sent = new Set(dispatched.map((d) => d.unit));
  return (
    <div className={`deploy ${size}`}>
      {UNITS.filter((u) => withCallback || u.id !== "callback").map((u) => {
        const isSent = sent.has(u.id), sug = suggested.includes(u.id);
        return (
          <button key={u.id} disabled={isSent || busy === u.id} className={isSent ? "sent" : sug ? "sugg" : ""}
            title={isSent ? "sent" : sug ? "suggested from what the caller said" : `send ${u.label}`}
            onClick={async (e) => { e.stopPropagation(); setBusy(u.id); setFailed(null); const ok = await onSend(u.id); setBusy(null); if (!ok) setFailed(u.id); }}>
            <span className="ico">{u.icon}</span>
            {isSent ? `✓ ${u.label} sent` : busy === u.id ? "Sending…" : failed === u.id ? `Retry ${u.label}` : `${sug ? "Send " : ""}${u.label}`}
            {keys && !isSent && <kbd>{u.key}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

export function UnitChips({ dispatched = [] }: { dispatched?: Dispatched[] }) {
  return <>{dispatched.map((d, i) => <span key={i} className="chip unit">✓ {UNITS.find((u) => u.id === d.unit)?.label || d.unit} sent {hms(d.at).slice(0, 5)}{d.by ? ` by ${d.by}` : ""}</span>)}</>;
}

export function Toasts({ items }: { items: { id: number; text: string; err?: boolean }[] }) {
  return <div className="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>{t.text}</div>)}</div>;
}

export function useToasts() {
  const [items, setItems] = useState<{ id: number; text: string; err?: boolean }[]>([]);
  const push = (text: string, err = false) => { const id = Date.now() + Math.random(); setItems((x) => [...x, { id, text, err }]); setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 3200); };
  return { items, push };
}
