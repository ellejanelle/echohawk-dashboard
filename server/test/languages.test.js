// Each of the 15 languages is told apart from one short thing a caller might say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, LANGUAGES } from "../languages.js";

const SAMPLES = {
  en: "Hi, this is zone six and there is no water at my house.",
  es: "Zona seis, no hay agua en mi casa.",
  zh: "我们家没有水了，在六区。",
  yue: "我屋企冇水呀，係六區。",
  ko: "6구역인데 집에 물이 안 나와요.",
  fil: "Wala pong tubig sa bahay namin dito sa zone anim.",
  hy: "Մեր տանը ջուր չկա, վեցերորդ գոտի։",
  vi: "Nhà tôi bị mất nước, khu vực sáu.",
  fa: "در خانه ما آب نیست، منطقه شش.",
  ru: "У нас дома нет воды, зона шесть.",
  ar: "لا يوجد ماء في بيتنا، المنطقة ستة.",
  ja: "家の水が出ません。ゾーン6です。",
  hi: "हमारे घर में पानी नहीं है, ज़ोन छह।",
  th: "บ้านฉันไม่มีน้ำ โซนหก",
  uk: "У нас вдома немає води, зона шість.",
};

test("there are exactly 15 languages and every one has a sample", () => {
  assert.equal(LANGUAGES.length, 15);
  for (const l of LANGUAGES) assert.ok(SAMPLES[l.code], `sample for ${l.code}`);
});

for (const [code, text] of Object.entries(SAMPLES)) {
  test(`detects ${code}`, () => assert.equal(detectLanguage(text, "en"), code));
}

test("a short ambiguous turn keeps the language already detected", () => {
  assert.equal(detectLanguage("ok", "ko"), "ko");
  assert.equal(detectLanguage("6", "hy"), "hy");
});
