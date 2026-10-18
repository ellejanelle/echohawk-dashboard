// A model may return a bare number for "zona seis"; the board needs Z06, and real districts keep 4 digits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeZone } from "../llm.js";

test("normalizeZone maps model output to board zones and LAPD districts", () => {
  for (const [input, want] of [["6", "Z06"], ["06", "Z06"], ["zone 6", "Z06"], ["Z6", "Z06"], ["Z06", "Z06"], ["zona seis", "Z06"], ["802", "0802"], ["RD 0802", "0802"], ["unknown", null], [null, null]]) {
    assert.equal(normalizeZone(input), want, `normalizeZone(${JSON.stringify(input)})`);
  }
});
