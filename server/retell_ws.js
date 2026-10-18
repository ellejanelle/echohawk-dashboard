// Retell custom LLM websocket handler. Spec: docs/BUILD_SPEC.md §6.1, IMPLEMENTATION_PLAN.md §3.1.
//
// Retell → us:  ping_pong | call_details | update_only | response_required | reminder_required
// us → Retell:  config | response | agent_interrupt | metadata
//
// Non-negotiables (spec §14):
//   • AI disclosure greeting on every connection (New Orleans lesson: callers must know it's AI)
//   • Hard triggers run first; a transfer starts within the same turn — never delayed by extraction
//   • Packet created the moment zone + target + severity + action are known (not at call end)
//   • AI never orders evacuations, dispatches units, closes incidents, or writes medical steps
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { scanTurn } from "./triggers.js";
import { extractFields, agentReply, translate, detectLanguage, nextFallbackLine } from "./llm.js";
import { LANG } from "./languages.js";
import { makePacket } from "./schema.js";
import { showKitCard, kitForFields } from "./kits.js";

// -------------------------------------------------------------------------
// Short system lines in the caller's language.
// English and Spanish are fixed strings; others are translated once and cached.
// -------------------------------------------------------------------------
const LINES = {
  connect:  { en: "I'm connecting you to a dispatcher right now. Stay on the line.",                        es: "Le estoy conectando con un despachador ahora mismo. No cuelgue." },
  takeover: { en: "A dispatcher is on the line with you now. Keep talking, we can hear you.",               es: "Un despachador está en la línea con usted ahora. Siga hablando, le escuchamos." },
};
const lineCache = new Map();
async function lineIn(key, lang) {
  const l = LINES[key];
  if (l[lang]) return l[lang];
  if (!LANG[lang]) return l.en;
  const ck = key + ":" + lang;
  if (lineCache.has(ck)) return lineCache.get(ck);
  const tr = await Promise.race([
    translate(l.en, lang, "en"),
    new Promise((r) => setTimeout(() => r(null), 2500)),
  ]).catch(() => null);
  if (tr && !tr.startsWith(`[${lang}]`)) { lineCache.set(ck, tr); return tr; }
  return l.en;
}

// The opening line must say: automated, a person can join any time, and where the caller is.
// (The New Orleans false alarm lesson: callers were not told they were talking to AI.)
export const GREETING = "You've reached EchoHawk, the city's overflow line. I'm an automated assistant, and a person can join any time, just say person. Para español, hable en español. Where are you right now?";

// -------------------------------------------------------------------------
// RetellHub: manages all active call websocket sessions
// -------------------------------------------------------------------------
export class RetellHub {
  /**
   * @param {{ store: import('./store.js').Store, engine: import('./engine.js').Engine }} opts
   */
  constructor({ store, engine }) {
    this.store = store;
    this.engine = engine;
    this.sessions = new Map(); // call_id → session object
  }

  /** Attach the WebSocket upgrade listener to an existing HTTP server. */
  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      const m = req.url.match(/^\/retell\/llm\/([^/?]+)/);
      if (!m) { if (!/^\/node(\?|$)/.test(req.url)) socket.destroy(); return; } // /node upgrades belong to node_ws.js
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onConnection(ws, decodeURIComponent(m[1]))
      );
    });
    return this;
  }

  onConnection(ws, callId) {
    const s = {
      callId,
      ws,
      transcript: [],
      fields: null,
      packetSent: false,
      dispatcherJoined: false,
      transferStarted: false,
      unintelligible: 0,
      interruptSeq: 0,
      callerLang: "en",
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(callId, s);

    // Record the call if it is not already known (restart recovery)
    if (!this.store.calls.find((c) => c.id === callId)) {
      this.store.calls.push({
        id: callId, started_at: s.startedAt, ended_at: null,
        language: "und", direction: "inbound", mode: "tuesday",
        status: "active", transfer_path: "none", dispatcher_id: null,
      });
    }
    this.store.appendEvent({
      event_type: "call_started", call_id: callId,
      actor: "system", provenance: "firsthand", payload_json: {},
    });

    // Send config before anything else so Retell knows we want call_details
    this.send(ws, { response_type: "config", config: { auto_reconnect: true, call_details: true, transcript_with_tool_calls: true } });
    // Speak first with the AI disclosure (response_id 0 is Retell's slot for the opening line)
    this.send(ws, { response_type: "response", response_id: 0, content: GREETING, content_complete: true });

    ws.on("message", (raw) =>
      this.onMessage(s, raw).catch((e) => console.error("ws handler error", e))
    );
    ws.on("close", () => {
      this.sessions.delete(callId);
      const c = this.store.calls.find((x) => x.id === callId);
      if (c && !c.ended_at) {
        c.ended_at = new Date().toISOString();
        c.status = c.status === "transferred" ? c.status : "ended";
      }
      this.store.appendEvent({
        event_type: "call_ended", call_id: callId,
        actor: "system", provenance: "firsthand", payload_json: {},
      });
      this.store.save();
    });
  }

  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  async onMessage(s, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.interaction_type) {
      case "ping_pong":
        return this.send(s.ws, { response_type: "ping_pong", timestamp: msg.timestamp });

      case "call_details": {
        s.callerLang = msg.call?.metadata?.language || s.callerLang;
        const c = this.store.calls.find((x) => x.id === s.callId);
        if (c) c.language = s.callerLang;
        return;
      }

      case "update_only":
        this.absorbTranscript(s, msg.transcript);
        return;

      case "reminder_required":
        return this.respond(s, msg, { reminder: true });

      case "response_required":
        return this.respond(s, msg, {});

      default:
        return;
    }
  }

  /** Merge Retell's full transcript into the session and the turn store.
   *  Retell sends the complete transcript on every message, with the last turn still growing.
   *  We update turns we already have (text changed) and append new ones.
   */
  absorbTranscript(s, transcript = []) {
    const list = transcript || [];
    const fresh = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const known = s.transcript[i];
      if (known) {
        if (known.content !== t.content) {
          known.content = t.content;
          const row = this.store.turns.find((x) => x.call_id === s.callId && x.idx === i);
          if (row) { row.text_original = t.content; row.ts_updated = new Date().toISOString(); }
          this.store.appendEvent({
            event_type: "turn_updated", call_id: s.callId,
            actor: t.role === "agent" ? "ai" : "device", provenance: "firsthand",
            payload_json: { idx: i, role: t.role, text: t.content },
          });
        }
        continue;
      }
      s.transcript.push({ role: t.role, content: t.content });
      fresh.push(t);
      this.store.turns.push({
        id: this.store.nextId("tn"), call_id: s.callId, idx: i, role: t.role,
        text_original: t.content, text_translated: null,
        lang_original: s.callerLang, ts: new Date().toISOString(),
      });
      this.store.appendEvent({
        event_type: "turn_added", call_id: s.callId,
        actor: t.role === "agent" ? "ai" : "device", provenance: "firsthand",
        payload_json: { role: t.role, text: t.content },
      });
    }

    // Translate finished user turns when a dispatcher has joined (Interpreter Mode)
    if (s.dispatcherJoined) {
      const lastUserIdx = s.transcript.map((t) => t.role).lastIndexOf("user");
      const row = this.store.turns.find((x) => x.call_id === s.callId && x.idx === lastUserIdx);
      if (row && row.translated_from !== row.text_original) {
        const src = row.text_original; row.translated_from = src;
        translate(src, "en", s.callerLang).then((tr) => {
          row.text_translated = tr;
          this.store.appendEvent({
            event_type: "turn_translated", call_id: s.callId,
            actor: "system", provenance: "firsthand",
            payload_json: { role: "user", text: tr },
          });
        });
      }
    }
    return fresh;
  }

  async respond(s, msg, { reminder }) {
    this.absorbTranscript(s, msg.transcript);
    const lastUser = [...s.transcript].reverse().find((t) => t.role === "user")?.content || "";

    // Detect language from the caller's own words (sticky once a non-English language is heard)
    const lang = detectLanguage(
      s.transcript.filter((t) => t.role === "user").map((t) => t.content).join(" "),
      s.callerLang
    );
    if (lang !== s.callerLang) {
      s.callerLang = lang;
      const c = this.store.calls.find((x) => x.id === s.callId);
      if (c) c.language = lang;
      this.store.appendEvent({
        event_type: "language_detected", call_id: s.callId,
        actor: "system", provenance: "firsthand", payload_json: { language: lang },
      });
      // Recognised but no matching voice (Cantonese today): flag for an interpreter
      if (LANG[lang] && !LANG[lang].speaks && c && !(c.flags || []).some((f) => f.flag === "needs_interpreter")) {
        c.flags = [...(c.flags || []), { flag: "needs_interpreter", at: new Date().toISOString(), by: "system" }];
        this.store.appendEvent({
          event_type: "call_flagged", call_id: s.callId,
          actor: "system", provenance: "firsthand",
          payload_json: { flag: "needs_interpreter", language: lang },
        });
      }
    }

    const triggers = scanTurn(lastUser);

    // ── 1) Hard trigger: start the transfer immediately; show card in parallel ──
    if (triggers.isHard && !s.transferStarted) {
      s.transferStarted = true;
      const kitId = kitForFields(s.fields, triggers);
      let kitScript = null;
      if (kitId) {
        const shown = showKitCard(
          { kit_id: kitId, zone_id: s.fields?.zone_id, call_id: s.callId, language: s.callerLang },
          this.store, "ai"
        );
        if (shown.ok) {
          kitScript = shown.script_lines;
          this.send(s.ws, { response_type: "metadata", metadata: { show_kit_card: shown } });
        }
      }
      this.store.appendEvent({
        event_type: "trigger_fired", call_id: s.callId,
        actor: "system", provenance: "firsthand",
        payload_json: { triggers: triggers.hard, kit_id: kitId },
      });
      await this.ensurePacket(s, { triggers, force: true });
      const line = kitScript ? kitScript.join(" ") : await lineIn("connect", s.callerLang);
      this.send(s.ws, {
        response_type: "response", response_id: msg.response_id,
        content: line, content_complete: true,
        ...this.transferDirective(s),
      });
      return;
    }

    // ── 2) Unintelligible: NENA two-attempt fail-safe ──
    if (lastUser && lastUser.trim().length < 2) {
      s.unintelligible += 1;
      if (s.unintelligible >= config.retell.unintelligibleAttemptsBeforeTransfer && !s.transferStarted) {
        s.transferStarted = true;
        this.send(s.ws, {
          response_type: "response", response_id: msg.response_id,
          content: "Let me connect you to a person who can help.",
          content_complete: true, ...this.transferDirective(s),
        });
        return;
      }
    }

    // ── 3) Field extraction and packet creation ──
    await this.ensurePacket(s, { triggers });

    // ── 4) Dispatcher has joined: AI goes silent except for reminder nudges ──
    if (s.dispatcherJoined) {
      if (reminder) this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: "", content_complete: true });
      return;
    }

    // ── 5) Non-emergency escalation after N turns at severity ≥ 4 ──
    const userTurns = s.transcript.filter((t) => t.role === "user").length;
    if (
      userTurns >= config.retell.nonEmergencyEscalateAfterTurns &&
      !s.transferStarted &&
      (s.fields?.severity || 1) >= 4
    ) {
      s.transferStarted = true;
      this.send(s.ws, {
        response_type: "response", response_id: msg.response_id,
        content: "I want a person to take this from here. Connecting you now.",
        content_complete: true, ...this.transferDirective(s),
      });
      return;
    }

    // ── 6) Kit card on low-severity power outage ──
    let kitScript = null;
    const kitId = kitForFields(s.fields, triggers);
    if (kitId && !s.kitShown) {
      const shown = showKitCard(
        { kit_id: kitId, zone_id: s.fields?.zone_id, call_id: s.callId, language: s.callerLang },
        this.store, "ai"
      );
      if (shown.ok) {
        s.kitShown = kitId;
        kitScript = shown.script_lines;
        this.send(s.ws, { response_type: "metadata", metadata: { show_kit_card: shown } });
      }
    }

    // ── 7) LLM reply (or rule-based fallback when no model is configured) ──
    if (kitScript || config.llm.apiKey) {
      const content = await agentReply(s.transcript, {
        fields: s.fields, kitScript, mode: "tuesday", language: s.callerLang, reminder,
      });
      this.send(s.ws, { response_type: "response", response_id: msg.response_id, content, content_complete: true });
      return;
    }

    // Rule-based stateful dialog (never repeats a question; ends politely; injury → transfer)
    if (reminder) {
      this.send(s.ws, {
        response_type: "response", response_id: msg.response_id,
        content: (await agentReply([], { language: s.callerLang, reminder: true })),
        content_complete: true,
      });
      return;
    }
    const step = nextFallbackLine(s.transcript, { fields: s.fields, language: s.callerLang });
    if (step.transfer && !s.transferStarted) {
      s.transferStarted = true;
      this.store.appendEvent({
        event_type: "trigger_fired", call_id: s.callId,
        actor: "system", provenance: "firsthand",
        payload_json: { triggers: ["caller_reports_injury"] },
      });
    }
    this.send(s.ws, {
      response_type: "response", response_id: msg.response_id,
      content: step.content, content_complete: true,
      ...(step.end_call ? { end_call: true } : {}),
      ...(step.transfer ? this.transferDirective(s) : {}),
    });
  }

  /** Extract fields from the transcript so far; create or refine the packet. */
  async ensurePacket(s, { triggers, force = false }) {
    const text = s.transcript.filter((t) => t.role === "user").map((t) => t.content).join("\n");
    s.fields = await extractFields(text);

    // If we already have a packet for this call, refine it in-place rather than creating another
    const intake = this.store.packets.find(
      (p) => p.call_id === s.callId && p.request_kind === "emergency_call"
    );
    if (intake) {
      this.engine.refine(
        intake,
        { ...s.fields, language: s.callerLang, content_status: s.fields.complete ? "extracted" : "partial" },
        triggers
      );
      s.packetSent = true;
      return;
    }
    if (s.packetSent) return;

    if (s.fields.complete || force) {
      const { packet, errors } = makePacket({
        source: "voice",
        zone_id: s.fields.zone_id || "unknown",
        target: s.fields.target,
        severity: s.fields.severity,
        action: s.fields.action,
        identifier: s.callId,
        call_id: s.callId,
        language: s.callerLang,
        content_status: s.fields.complete ? "extracted" : "partial",
        mode: this.mode(),
      });
      if (errors.length) { console.warn("packet rejected", errors); return; }
      this.engine.ingest(packet, { triggers });
      s.packetSent = true;
    }
  }

  /** Twist 1 funded-capacity governor: beyond paid concurrency, calls are tagged "crisis". */
  mode() {
    return this.sessions.size > config.paidConcurrency ? "crisis" : "tuesday";
  }

  transferDirective(s) {
    const call = this.store.calls.find((c) => c.id === s.callId);
    const dest = process.env.TRANSFER_NUMBER || "";
    if (call) { call.status = "transferred"; call.transfer_path = dest ? "cold_a" : "none"; }
    this.store.appendEvent({
      event_type: "transfer_started", call_id: s.callId,
      actor: "system", provenance: "firsthand",
      payload_json: { path: dest ? "cold_a" : "console_only", fields: s.fields },
    });
    return dest ? { transfer_number: dest } : {};
  }

  // ── Interpreter Mode (dispatcher console) ──────────────────────────────

  join(callId, dispatcherId) {
    const s = this.sessions.get(callId);
    if (!s) return { ok: false, status: 404 };
    s.dispatcherJoined = true;
    const c = this.store.calls.find((x) => x.id === callId);
    if (c) c.dispatcher_id = dispatcherId;
    this.store.appendEvent({
      event_type: "dispatcher_joined", call_id: callId,
      actor: "dispatcher", provenance: "firsthand",
      payload_json: { dispatcher_id: dispatcherId },
    });
    // Catch the dispatcher up: translate everything said so far into English
    if (s.callerLang && s.callerLang !== "en") {
      for (const row of this.store.turns.filter(
        (t) => t.call_id === callId &&
          (t.role === "user" || t.role === "agent") &&
          !t.text_translated &&
          t.translated_from !== t.text_original
      )) {
        const src = row.text_original; row.translated_from = src;
        translate(src, "en", s.callerLang)
          .then((tr) => {
            row.text_translated = tr;
            this.store.appendEvent({
              event_type: "turn_translated", call_id: callId,
              actor: "system", provenance: "firsthand",
              payload_json: { role: row.role, text: tr },
            });
          })
          .catch(() => {});
      }
    }
    return { ok: true, caller_language: s.callerLang };
  }

  /** Dispatcher takes over: join (AI goes quiet) and tell the caller a person is on the line. */
  async takeover(callId, dispatcherId = "dispatcher") {
    const s = this.sessions.get(callId);
    if (!s) return { ok: false, status: 404 };
    this.join(callId, dispatcherId);
    const c = this.store.calls.find((x) => x.id === callId);
    if (c) { c.status = "transferred"; c.transfer_path = "console_takeover"; }
    const line = await lineIn("takeover", s.callerLang);
    s.interruptSeq += 1;
    this.send(s.ws, {
      response_type: "agent_interrupt", interrupt_id: s.interruptSeq,
      content: line, content_complete: true, no_interruption_allowed: false,
    });
    this.store.appendEvent({
      event_type: "transfer_started", call_id: callId,
      actor: "dispatcher", provenance: "firsthand",
      payload_json: { path: "console_takeover" },
    });
    return { ok: true, caller_language: s.callerLang };
  }

  /** Send a dispatcher message to the caller in the caller's language. */
  async say(callId, text, fromLang = "en") {
    const s = this.sessions.get(callId);
    if (!s) return { ok: false, status: 404 };
    const toLang = s.callerLang === "und" ? "en" : s.callerLang;
    const sent = toLang === fromLang ? text : await translate(text, toLang, fromLang);
    s.interruptSeq += 1;
    this.send(s.ws, {
      response_type: "agent_interrupt", interrupt_id: s.interruptSeq,
      content: sent, content_complete: true, no_interruption_allowed: false,
    });
    s.transcript.push({ role: "agent", content: sent });
    this.store.turns.push({
      id: this.store.nextId("tn"), call_id: callId,
      idx: s.transcript.length - 1, role: "dispatcher",
      text_original: text, text_translated: sent,
      lang_original: fromLang, ts: new Date().toISOString(),
    });
    this.store.appendEvent({
      event_type: "dispatcher_said", call_id: callId,
      actor: "dispatcher", provenance: "firsthand",
      payload_json: { text, sent_text: sent, lang_to: toLang },
    });
    return { ok: true, sent_text: sent, lang_to: toLang };
  }

  setLanguage(callId, lang) {
    const s = this.sessions.get(callId);
    if (s) s.callerLang = lang;
    const c = this.store.calls.find((x) => x.id === callId);
    if (c) c.language = lang;
  }
}
