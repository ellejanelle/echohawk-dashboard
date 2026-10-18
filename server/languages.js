// The 15 languages EchoHawk recognizes.
// Chosen from LA County DMH threshold languages (Arabic, Armenian, Cantonese, Mandarin, English,
// Farsi, Korean, Russian, Spanish, Tagalog, Vietnamese; https://dmh.lacounty.gov/language-access-plan/)
// plus Japanese, Hindi, Thai and Ukrainian, limited to what Retell's speech recognition supports
// (https://docs.retellai.com/build/language-support).
// Khmer is an LA County threshold language but Retell lists no speech recognition for it, so it is absent.
// `speaks: false` means Retell has recognition but no paired voice (Cantonese voices are only on
// Retell Platform and MiniMax, which do not cover Armenian), so those calls are flagged for an interpreter.

export const LANGUAGES = [
  { code: "en",  name: "English",             native: "English",    retell: "en-US",  speaks: true  },
  { code: "es",  name: "Spanish",             native: "Español",    retell: "es-419", speaks: true  },
  { code: "zh",  name: "Mandarin Chinese",    native: "普通话",       retell: "zh-CN",  speaks: true  },
  { code: "yue", name: "Cantonese",           native: "廣東話",       retell: "yue-CN", speaks: false },
  { code: "ko",  name: "Korean",              native: "한국어",       retell: "ko-KR",  speaks: true  },
  { code: "fil", name: "Tagalog (Filipino)",  native: "Tagalog",    retell: "fil-PH", speaks: true  },
  { code: "hy",  name: "Armenian",            native: "Հայերեն",    retell: "hy-AM",  speaks: true  },
  { code: "vi",  name: "Vietnamese",          native: "Tiếng Việt", retell: "vi-VN",  speaks: true  },
  { code: "fa",  name: "Persian (Farsi)",     native: "فارسی",      retell: "fa-IR",  speaks: true  },
  { code: "ru",  name: "Russian",             native: "Русский",    retell: "ru-RU",  speaks: true  },
  { code: "ar",  name: "Arabic",              native: "العربية",    retell: "ar-SA",  speaks: true  },
  { code: "ja",  name: "Japanese",            native: "日本語",       retell: "ja-JP",  speaks: true  },
  { code: "hi",  name: "Hindi",               native: "हिन्दी",      retell: "hi-IN",  speaks: true  },
  { code: "th",  name: "Thai",                native: "ไทย",        retell: "th-TH",  speaks: true  },
  { code: "uk",  name: "Ukrainian",           native: "Українська", retell: "uk-UA",  speaks: true  },
];

/** Lookup map: language code → language object */
export const LANG = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

/** Human-readable name for a language code; falls back to the code itself. */
export const langName = (code) => LANG[code]?.name || code;

// ---------------------------------------------------------------------------
// Word lists for Latin-script languages (the others are told apart by their
// writing system and need no word list).
// ---------------------------------------------------------------------------
const WORDS = {
  en: /\b(the|my|is|are|our|there|water|power|zone|fire|help|someone|hurt|please|no one|street|house|out|have)\b/gi,
  es: /\b(zona|hola|ayuda|por favor|se fue|la luz|sin luz|agua|presi[oó]n|fuego|incendio|humo|herid[oa]|sangr\w*|respira|calle|casa|mi |est[aá]|hay|nadie|s[ií]|gracias|necesito|cuatro|cinco|seis|siete|ocho|nueve|tres|dos|uno|cero|aqu[ií]|ahora|se cay[oó]|no hay|olor a gas)\b/gi,
  fil: /\b(ang|ng|mga|po|opo|sa|ako|kami|tayo|wala|walang|tubig|kuryente|sunog|tulong|tulungan|may|nasaktan|bahay|kalye|dito|ngayon|salamat|hindi|oo|isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam)\b/gi,
};

// Script-range and character-set markers used before falling back to word scoring
const VI_MARKS  = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
const CANTONESE = /[嘅唔係咗喺冇佢啲嘢乜嗰咩㗎囉嚟]/;
// Persian has four letters Arabic lacks (پ چ ژ گ) and writes ye/kaf as ی/ک where Arabic uses ي/ك
const PERSIAN   = /[پچژگیک]/;
const UKRAINIAN = /[іїєґІЇЄҐ]/;

/**
 * Detect the caller's language from what they said.
 * Retell's multilingual recognition sends text rather than a language tag.
 * Sticky: a short or ambiguous turn keeps the language already detected.
 *
 * @param {string} text      Caller's utterance
 * @param {string} [current] Previously detected language code (default "en")
 * @returns {string} BCP-47-ish language code
 */
export function detectLanguage(text, current = "en") {
  const t = String(text || "");
  if (!t.trim()) return current;

  // Script-range fast paths — no ambiguity, no word scoring needed
  if (/[぀-ヿ]/.test(t))     return "ja";                                  // kana
  if (/[가-힯ᄀ-ᇿ]/.test(t)) return "ko";                                  // hangul
  if (/[一-鿿]/.test(t))     return CANTONESE.test(t) ? "yue" : "zh";      // han
  if (/[԰-֏]/.test(t))     return "hy";                                   // armenian
  if (/[฀-๿]/.test(t))     return "th";                                   // thai
  if (/[ऀ-ॿ]/.test(t))     return "hi";                                   // devanagari
  if (/[؀-ۿ]/.test(t))     return PERSIAN.test(t) ? "fa" : "ar";         // arabic script
  if (/[Ѐ-ӿ]/.test(t))     return UKRAINIAN.test(t) ? "uk" : "ru";       // cyrillic
  if (VI_MARKS.test(t))      return "vi";
  if (/[ñ¿¡]/.test(t))      return "es";

  // Word-frequency scoring for Latin-script languages
  const n = Object.fromEntries(
    Object.entries(WORDS).map(([k, re]) => [k, (t.match(re) || []).length])
  );
  const [best, count] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  const second = Object.values(n).sort((a, b) => b - a)[1];
  if (count >= 2 && count > second) return best;

  return current; // ambiguous — keep whatever was already detected
}
