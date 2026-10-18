// Mirrors server/languages.js: the 15 languages EchoHawk recognizes.
export const LANGUAGES = [
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "zh", name: "Mandarin", native: "普通话" },
  { code: "yue", name: "Cantonese", native: "廣東話" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "fil", name: "Tagalog", native: "Tagalog" },
  { code: "hy", name: "Armenian", native: "Հայերեն" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "fa", name: "Farsi", native: "فارسی" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
] as const;
const BY = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));
export const langName = (code?: string) => (code && BY[code] ? BY[code].name : "Language not set");
export const langNative = (code?: string) => (code && BY[code] ? BY[code].native : "");
