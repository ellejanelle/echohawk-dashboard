// Central configuration constants. Every tunable number lives here with its source/basis so the
// board can show "why". Spec references: docs/BUILD_SPEC.md Sections 4 and 5.
// "team judgment" means not externally sourced; change freely during calibration.

export const config = {
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8787",
  salt: process.env.ECHOHAWK_SALT || "dev-salt",
  frameKey: process.env.ECHOHAWK_FRAME_KEY || "dev-frame-key",
  // Retell signs webhooks with the API key (retell-sdk webhook_auth)
  retellWebhookSecret: process.env.RETELL_WEBHOOK_SECRET || process.env.RETELL_API_KEY || "",
  paidConcurrency: Number(process.env.PAID_CONCURRENCY || 20),
  tokens: {
    dispatcher: process.env.DISPATCHER_TOKEN || "dev-dispatcher",
    supervisor: process.env.SUPERVISOR_TOKEN || "dev-supervisor",
    // alerting agencies: OEM, Sheriff, Fire, LAPD, LAFD, EMD
    agency: process.env.AGENCY_TOKEN || "dev-agency",
  },

  // Claude (Anthropic Messages API) when ANTHROPIC_API_KEY is set;
  // otherwise any OpenAI-compatible endpoint; otherwise rules.
  get llm() {
    // A Claude key works on either env var: ANTHROPIC_API_KEY, or LLM_API_KEY when it starts with sk-ant-
    const claudeKey =
      process.env.ANTHROPIC_API_KEY ||
      (/^sk-ant-/.test(process.env.LLM_API_KEY || "") ? process.env.LLM_API_KEY : "");
    return claudeKey
      ? {
          provider: "anthropic",
          baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
          apiKey: claudeKey,
          model: /^claude/.test(process.env.LLM_MODEL || "") ? process.env.LLM_MODEL : "claude-haiku-5-5",
          timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 4000),
        }
      : {
          provider: "openai",
          baseUrl: process.env.LLM_BASE_URL || "",
          apiKey: process.env.LLM_API_KEY || "",
          model: process.env.LLM_MODEL || "gpt-4o-mini",
          timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 4000),
        };
  }, // evaluated at call time so env overrides in tests take effect

  engine: {
    mergeWindowMs: 15 * 60 * 1000,       // anchored to RapidSOS patent 15-min block, Jasso 2007 10-min spacing
    keepAliveMs: 2 * 60 * 60 * 1000,     // team judgment
    pFalse: 0.5,                          // team judgment; unverified-voice false-report prob in 1-p^n (not calibrated)
    handScore: 0.85,                      // team judgment
    handIndependentCount: 3,              // anchored to Eaton 14 reports, Astroworld 5 unconscious-person calls
    askIndependentCount: 2,               // team judgment
    singleCallerCap: 0.6,                 // one caller lifts score at most to 60% of hand threshold; team judgment
    highConsequenceTargets: ["structure_fire", "wildfire", "gas", "power_line", "flood"], // one report = ask
    rateSurgeMultiplier: 3,               // Maui ran ~2.8x normal day, Harvey >8x; team judgment
    scanWindowMs: 15 * 60 * 1000,
    scanPoissonTail: 1e-4,                // Cincinnati EPA used p<0.025 on daily scan, flagged 85 false alarms
    scanMinCount: 3,
    weights: {
      voice: 1.0, app: 1.0, ehawk: 1.0, field_unit: 1.0, telemetry: 1.0,
      same_household_second_line: 0.25, repeat_caller: 0,
    },
    machineSources: ["telemetry"],        // alarm activations are a separate source class (Palisades 906 ringers)
  },

  retell: {
    nonEmergencyEscalateAfterTurns: 6,        // team judgment
    unintelligibleAttemptsBeforeTransfer: 2,  // NENA 2025 practitioner fail-safe
  },
};
