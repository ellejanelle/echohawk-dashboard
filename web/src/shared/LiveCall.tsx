import "./livecall.css";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Turn } from "./types";
import { Icon } from "./Brand";

import { LANGUAGES, langName } from "./languages";
export { langName };
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export interface LiveCallInfo { id: string; language?: string; live: boolean; status?: string }

// Live transcript with translation, plus the three ways a person can step in:
// listen (read along), Join interpreter (the AI goes quiet, you talk through translation), Take over (you have the call).
export function LiveCall({ call, tok, version, joined, onJoined, onChanged, toast, showTakeover = false }: {
  call: LiveCallInfo; tok: string; version: number; joined: boolean;
  onJoined: () => void; onChanged: () => void; toast: (t: string, err?: boolean) => void; showTakeover?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [say, setSay] = useState("");
  const [lang, setLang] = useState("en");
  const [mic, setMic] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const rec = useRef<any>(null);

  // poll while live so the transcript moves even between server events
  useEffect(() => {
    let alive = true;
    const load = () => api.transcript(call.id).then((t) => alive && setTurns(t)).catch(() => {});
    load();
    const t = call.live ? setInterval(load, 1500) : undefined;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [call.id, call.live, version]);
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [turns.length, call.id]);

  const isJoined = joined || call.status === "transferred";
  const join = async () => {
    if (isJoined) return;
    const r = await api.join(tok, call.id);
    if (r.ok) { onJoined(); toast("Interpreter on. The AI goes quiet while you're on the line."); } else toast(r.data.error || "This call is no longer live", true);
  };
  const take = async () => {
    const r = await api.takeover(tok, call.id);
    if (r.ok) { onJoined(); toast("You have the call. The caller was told a dispatcher is on the line."); } else toast(r.data.error || "This call is no longer live", true);
    onChanged();
  };
  const send = async (text = say) => {
    const t = text.trim(); if (!t) return; setSay("");
    const r = await api.say(tok, call.id, t, lang);
    if (!r.ok) toast(r.data.error || "Join the call first", true);
    api.transcript(call.id).then(setTurns).catch(() => {});
  };
  const micDown = () => {
    if (!SR) return toast("Speech recognition is not available in this browser; type instead", true);
    const r = new SR(); r.interimResults = false; r.lang = ({ en: "en-US", es: "es-MX", zh: "zh-CN", yue: "zh-HK", ko: "ko-KR", fil: "fil-PH", hy: "hy-AM", vi: "vi-VN", fa: "fa-IR", ru: "ru-RU", ar: "ar-SA", ja: "ja-JP", hi: "hi-IN", th: "th-TH", uk: "uk-UA" } as Record<string, string>)[lang] || "en-US";
    r.onresult = (e: any) => send(e.results[0][0].transcript); rec.current = r; r.start(); setMic(true);
  };

  return (
    <div className="livecall">
      {call.live && (
        <div className="lc-mode">
          <span className={`lc-step ${!isJoined ? "on" : ""}`}>{Icon.eye(!isJoined ? "#3cc7b4" : "#5f6d82")}Listening</span>
          <span className={`lc-step ${isJoined && call.status !== "transferred" ? "on" : ""}`}>{Icon.users(isJoined && call.status !== "transferred" ? "#3cc7b4" : "#5f6d82")}Interpreting</span>
          <span className={`lc-step ${call.status === "transferred" ? "on red" : ""}`}>{Icon.phoneSolid(call.status === "transferred" ? "#e5484d" : "#5f6d82", 14)}You have the call</span>
          <span className="spacer" />
          {showTakeover && call.status !== "transferred" && <button className="takebtn" onClick={take}>{Icon.phoneSolid("#fff", 14)} Take over</button>}
        </div>
      )}
      <div className="bubbles" ref={body}>
        {turns.length ? turns.map((t, k) => {
          const mine = t.role !== "user";
          const who = t.role === "user" ? "R" : t.role === "agent" ? "AI" : "D";
          const trLabel = t.role === "user" ? "Translation (English)" : t.role === "agent" ? "Translation (English)" : `${langName(call.language)} (to caller)`;
          return (
            <div key={k} className={`msg ${mine ? "me" : ""} ${t.role}`}>
              {!mine && <span className="av">{who}</span>}
              <div className="bub">
                <div className="txt">{t.text_original}</div>
                {t.text_translated && t.text_translated !== t.text_original && <div className="tr"><span>{trLabel}</span>{t.text_translated}</div>}
              </div>
              {mine && <span className={`av ${t.role}`}>{who}</span>}
            </div>
          );
        }) : <div className="placeholder">Waiting for the caller's first words.</div>}
        {call.live && !isJoined && turns.length > 0 && call.language && call.language !== "en" && (
          <div className="lc-hint">Join interpreter to see every line translated and to speak to the caller in {langName(call.language)}.</div>
        )}
      </div>
      <div className="composer">
        <span className="clip">{Icon.clip("#8d9aae")}</span>
        <select value={lang} onChange={(e) => setLang(e.target.value)} title="The language you type in">{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()} · {l.name}</option>)}</select>
        <input value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} disabled={!call.live || !isJoined}
          placeholder={!call.live ? "This call has ended" : isJoined ? "Type a message to the caller..." : "Join interpreter to talk to the caller"} />
        <button className={`micbtn ${mic ? "on" : ""}`} disabled={!call.live || !isJoined} onMouseDown={micDown} onMouseUp={() => { rec.current?.stop(); setMic(false); }} title="Hold to talk">{Icon.mic(mic ? "#3cc7b4" : "#c2cbd8")}</button>
        <button className="btn-teal" disabled={!call.live || !isJoined} onClick={() => send()}>Send</button>
        <button className={`joinbtn ${isJoined ? "on" : ""}`} disabled={!call.live || isJoined} onClick={join}>{Icon.users(isJoined ? "#3cc7b4" : "#dbe2ec")} {isJoined ? "Interpreter on" : "Join interpreter"}</button>
      </div>
    </div>
  );
}
