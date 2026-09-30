// Port of m2c tests/unit/test_arm.py
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cc, parse_suffix } from "../../src/arch_arm.js";

function parse_cc(cc) {
  if (!cc) return null;
  if (cc === "hs") return Cc.CS;
  if (cc === "lo") return Cc.CC;
  return Cc.of(cc);
}

test("parse_suffix handles all known instructions", () => {
  const dirs = ",ia,ib,da,db,fa,fd,ea,ed".split(",");
  const cc_strs = ",hs,lo,eq,ne,cs,cc,mi,pl,vs,vc,hi,ls,ge,lt,gt,le,al".split(",");
  const ccs = cc_strs.map((s) => [s, parse_cc(s)]);

  for (const mn of [
    "b", "bl", "blx", "bx", "clz", "cmn", "cmp", "cpy", "ldr", "ldrb", "ldrh", "ldrsb", "ldrsh", "mla", "nop",
    "pop", "push", "rbit", "rev", "rev16", "sdiv", "sdiv", "smlabb", "smulbb", "str", "strb", "strh",
    "tablejmp.fictive", "teq", "tst", "udiv",
  ]) {
    for (const [cc_str, cc] of ccs) assert.deepEqual(parse_suffix(mn + cc_str), [mn, cc, "", ""], mn + cc_str);
  }

  for (const [cc_str, cc] of ccs) {
    for (const sz of ["sb", "b", "sh", "h"]) assert.deepEqual(parse_suffix(`ldr${cc_str}${sz}`), [`ldr${sz}`, cc, "", ""]);
    for (const sz of ["b", "h"]) assert.deepEqual(parse_suffix(`str${cc_str}${sz}`), [`str${sz}`, cc, "", ""]);
  }

  for (const mn of [
    "adc", "add", "and", "asr", "bic", "eor", "lsl", "lsr", "mov", "mul", "mvn", "neg", "orn", "orr", "ror",
    "rrx", "rsb", "rsc", "sbc", "smlal", "smull", "sub", "umlal", "umull",
  ]) {
    for (const [cc_str, cc] of ccs) {
      for (const s of ["", "s"]) {
        assert.deepEqual(parse_suffix(mn + cc_str + s), [mn, cc, s, ""]);
        assert.deepEqual(parse_suffix(mn + s + cc_str), [mn, cc, s, ""]);
      }
    }
  }

  for (const mn of ["stm", "ldm"]) {
    for (const [cc_str, cc] of ccs) {
      const tr = { fa: ["da", "ib"], ea: ["db", "ia"], fd: ["ia", "db"], ed: ["ib", "da"] };
      for (const d of dirs) {
        let exp = d;
        if (Object.hasOwn(tr, d)) exp = tr[d][mn === "ldm" ? 0 : 1];
        assert.deepEqual(parse_suffix(`${mn}${cc_str}${d}`), [mn, cc, "", exp]);
      }
    }
  }

  for (const mn of ["it", "cbz", "cbnz"]) assert.deepEqual(parse_suffix(mn), [mn, null, "", ""]);
});
