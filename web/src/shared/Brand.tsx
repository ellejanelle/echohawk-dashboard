import { useState } from "react";

// Original EchoHawk mark: three swept wing strokes and a head, drawn in the accent color.
export function Logo({ size = 30, color = "var(--teal)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 22 C12 10, 24 6, 36 6 C30 10, 26 13, 23 17 Z" fill={color} />
      <path d="M8 27 C15 19, 23 16, 31 15 C27 18, 24 21, 21 24 Z" fill={color} opacity=".8" />
      <path d="M13 32 C18 27, 23 25, 27 24 C25 27, 23 29, 20 31 Z" fill={color} opacity=".6" />
      <circle cx="33" cy="9.5" r="2.2" fill={color} />
    </svg>
  );
}

export type Tab = { key: string; label: string; href: string };

export const SUPERVISOR_TABS: Tab[] = [
  { key: "overview", label: "Overview", href: "/board" },
  { key: "calls", label: "Live calls", href: "/console" },
  { key: "replay", label: "Replay", href: "/replay" },
  { key: "alerts", label: "Public alerts", href: "/alerts" },
];

// Top bar from the interface concept: mark, wordmark, tabs, system status, role menu.
export function AppHeader({ tabs, current, role, online, right }: { tabs: Tab[]; current: string; role: "Supervisor" | "Dispatcher" | "Viewer"; online: boolean; right?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const q = location.search;
  return (
    <header className="apphead">
      <a className="mark" href={`/board${q}`}><Logo /><span>EchoHawk</span></a>
      <nav className="tabsnav">
        {tabs.map((t) => <a key={t.key} href={t.key === "replay" || t.key === "alerts" ? t.href : t.href + q} className={t.key === current ? "on" : ""}>{t.label}</a>)}
      </nav>
      <span className="spacer" />
      {right}
      <span className={`sys ${online ? "" : "off"}`}><i />{online ? "System online" : "Reconnecting…"}</span>
      <span className="divider" />
      <div className="role" onClick={() => setOpen((o) => !o)}>
        <span className="avatar"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8.5" r="4" fill="currentColor" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" /></svg></span>
        {role}<span className="caret">▾</span>
        {open && (
          <div className="rolemenu" onClick={(e) => e.stopPropagation()}>
            <a href="/board?token=dev-supervisor">Supervisor view</a>
            <a href="/console?token=dev-dispatcher">Dispatcher view</a>
            <a href="/replay">Replay</a>
          </div>
        )}
      </div>
    </header>
  );
}

// Line icons used in the stat cards and lists.
export const Icon = {
  person: (c: string) => <svg viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="7.5" r="4.2" fill={c} /><path d="M3.5 21.5c0-4.9 3.8-8 8.5-8s8.5 3.1 8.5 8z" fill={c} /></svg>,
  clipboard: (c: string) => <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="4.5" width="14" height="17" rx="2" /><rect x="9" y="2.5" width="6" height="4" rx="1" /><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" /></svg>,
  eye: (c: string) => <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke={c} strokeWidth="1.9"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" /><circle cx="12" cy="12" r="3.4" fill={c} /></svg>,
  phone: (c: string, s = 30) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16.6v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 3.9 2 2 0 0 1 3.1 1.7h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.5a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z" /></svg>,
  phoneSolid: (c: string, s = 20) => <svg viewBox="0 0 24 24" width={s} height={s}><path fill={c} d="M21 16.6v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 3.9 2 2 0 0 1 3.1 1.7h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.5a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z" /></svg>,
  clock: (c: string) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  info: (c: string) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>,
  chevron: (c = "currentColor") => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>,
  flashlight: (c: string) => <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round"><path d="M6 3h12v4l-3 4v10H9V11L6 7z" /><path d="M6 7h12M12 14v2" /></svg>,
  bag: (c: string) => <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round"><rect x="5" y="7" width="14" height="14" rx="3" /><path d="M9 7V5a3 3 0 0 1 6 0v2M5 13h14M10 16h4" /></svg>,
  aid: (c: string) => <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round"><rect x="3.5" y="6.5" width="17" height="14" rx="2.5" /><path d="M9 6.5V4.5h6v2M12 10.5v6M9 13.5h6" /></svg>,
  users: (c: string) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" /></svg>,
  clip: (c: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></svg>,
  mic: (c: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  bell: (c: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>,
};
