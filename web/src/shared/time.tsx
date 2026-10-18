import { useEffect, useState } from "react";

export const hms = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

export function duration(start: string, end?: string | null): string {
  if (!end) return ago(start);
  const s = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s call`;
}

// Re-render once a second so timers and clocks stay live.
export function useTick(ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

export function Clock({ className = "clock" }: { className?: string }) {
  useTick();
  return <span className={className}>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>;
}
