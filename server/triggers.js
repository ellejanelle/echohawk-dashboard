// Hard and soft trigger detection. Spec: docs/BUILD_SPEC.md Section 5.
// Regex runs first — it must fire within one turn (spec §14 hard triggers start a transfer within one turn).
// Sources: Riou 2018 (qualified breathing), Berdowski 2009, Ball 2018, Camp Fire logs,
// DC hot-car, Aiken SC, NENA 2025 two-attempt fail-safe, Crisis Text Line indirect self-harm terms.
// English and Spanish patterns for the demo; add per-county languages in the HARD/SOFT arrays.

const HARD = [
  {
    id: "breathing_qualified",
    re: /\b(not|isn'?t|is not|no está|no esta|ya no)\s+breath|\b(gasp|gasping|sort of breathing|barely breathing|snoring|occasional breath|jadea|boquea|respira (raro|mal|apenas)|no respira)\b/i,
  },
  {
    id: "unconscious",
    re: /\b(unconscious|unresponsive|won'?t wake|not waking|passed out|collapsed|inconsciente|no responde|no despierta|desmay)/i,
  },
  {
    id: "trapped",
    re: /\b(trapped|can'?t get out|cannot get out|stuck inside|fire inside|water inside|atrapad|no puedo salir|no podemos salir)/i,
  },
  {
    id: "dependent_alone",
    re: /\b(baby|infant|child|kid|toddler|grandma|grandpa|disabled|wheelchair|bedridden)\b.*\b(alone|locked|stuck|not breathing|can'?t move)|\b(bebé|bebe|niñ|niñ|abuel)\w*.*\b(sol[oa]|encerrad|atrapad|no respira)/i,
  },
  {
    id: "violence",
    re: /\b(gun|shooting|shot|stabbed|knife|weapon|attacking|he'?s hitting|arma|pistola|disparo|cuchillo|me está pegando|me esta pegando)\b/i,
  },
  {
    id: "asks_for_human",
    re: /\b(real person|human|operator|dispatcher|speak to someone|talk to someone|una persona|un humano|operador[ae]?|hablar con alguien)\b/i,
  },
  {
    id: "self_harm",
    re: /\b(kill myself|end it|suicid|overdos|pills|tylenol|ibuprofen|advil|excedrin|antifreeze|bridge|jump off|quitarme la vida|suicid|pastillas)\b/i,
  },
  {
    id: "insists_higher_severity",
    re: /\b(cardiac arrest|heart attack|dying|she'?s dying|he'?s dying|not a drill|paro cardíaco|paro cardiaco|infarto|se está muriendo|se esta muriendo)\b/i,
  },
  {
    id: "severe_bleeding",
    re: /\b(bleeding (badly|a lot|heavily|won'?t stop)|blood everywhere|spurting|sangra mucho|mucha sangre|no para de sangrar)\b/i,
  },
];

const SOFT = [
  { id: "distress",           re: /\b(please hurry|oh my god|help us|screaming|crying|por favor|ayuda|dios mío|dios mio)\b/i,                                                          weight: 0.5 },
  { id: "electrical",         re: /\b(spark|sparks|transformer|pop|popping|lines? down|wire down|chispa|transformador|cable caído|cable caido)\b/i,                                     weight: 0.7 },
  { id: "gas_or_pressure",    re: /\b(smell gas|gas smell|rotten egg|water pressure|no water pressure|huele a gas|olor a gas|presión de agua|presion de agua)\b/i,                       weight: 0.7 },
  { id: "third_party_vulnerable", re: /\b(my (mother|father|neighbor|grandmother|grandfather)|mi (madre|padre|vecin[oa]|abuel[oa]))\b/i,                                               weight: 0.3 },
];

/**
 * Scan one turn of transcript text for hard and soft triggers.
 * Hard triggers require an immediate transfer (spec §14).
 *
 * @param {string} text
 * @returns {{ hard: string[], soft: Array<{id,weight}>, isHard: boolean }}
 */
export function scanTurn(text) {
  const t = String(text || "");
  const hard = HARD.filter((h) => h.re.test(t)).map((h) => h.id);
  const soft = SOFT.filter((s) => s.re.test(t)).map((s) => ({ id: s.id, weight: s.weight }));
  return { hard, soft, isHard: hard.length > 0 };
}

/** Maps hard trigger ids to the kit that should be auto-loaded. */
export const KIT_FOR_TRIGGER = {
  severe_bleeding: "EH-BLEED-001",
};
