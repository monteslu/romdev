// instrument-alias.js - profiled alias-state tracing for statically
// recompiled IDO 5.3 uopt (instrument-uopt-alias): base provenance and
// base-noalias decisions, gated on DKWB_UOPT_ALIAS_TRACE. The generated source
// must be the pinned profile unless --allow-unverified-source.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { ValueError, strRepr } from "./py.js";
import { IDO_53_V12_SHA256 } from "./instrument-uopt.js";

export const MARKER = "DKWB_UOPT_ALIAS_TRACE_V1";

export const HEADER = [
  "",
  "/* DKWB_UOPT_ALIAS_TRACE_V1",
  " * Trace-only hooks for the pinned IDO 5.3 static-recomp uopt profile.",
  " * Disabled unless DKWB_UOPT_ALIAS_TRACE is present in the environment.",
  " */",
  "#include <stdio.h>",
  "#include <stdlib.h>",
  "static int dkwb_alias_trace_state = -1;",
  "static unsigned long dkwb_alias_base_ordinal;",
  "static unsigned long dkwb_alias_query_ordinal;",
  "static uint32_t dkwb_alias_current_register;",
  "static int dkwb_alias_trace_on(void) {",
  "    if (dkwb_alias_trace_state < 0) {",
  "        const char *value = getenv(\"DKWB_UOPT_ALIAS_TRACE\");",
  "        dkwb_alias_trace_state =",
  "            value != NULL && *value != '\\0' && *value != '0';",
  "    }",
  "    return dkwb_alias_trace_state;",
  "}",
  "static const char *dkwb_alias_kind(uint32_t kind) {",
  "    switch (kind) {",
  "    case 1: return \"islda\";",
  "    case 2: return \"isop\";",
  "    case 3: return \"isvar\";",
  "    case 4: return \"issvar\";",
  "    case 5: return \"isilda\";",
  "    case 6: return \"dumped\";",
  "    default: return \"unknown\";",
  "    }",
  "}",
  "",
].join("\n");

/** [old, new, label] for each exact-anchor edit, in application order. */
const ANCHORS = [
  ["#include \"header.h\"\n", "#include \"header.h\"\n" + HEADER, "instrumentation header"],
  [[
  "L420e28:",
  "// bdead 21 ra = MEM_U32(sp + 36);",
  "// bdead 21 sp = sp + 0x28;",
  "v0 = a0 < 0x1;",
].join("\n"),
  [
  "L420e28:",
  "// bdead 21 ra = MEM_U32(sp + 36);",
  "// bdead 21 sp = sp + 0x28;",
  "if (dkwb_alias_trace_on()) {",
  "    uint32_t dkwb_left = MEM_U32(sp + 40);",
  "    uint32_t dkwb_right = MEM_U32(sp + 44);",
  "    fprintf(stderr, \"DKWB-ALIAS-QUERY ordinal=%lu reg=%u result=%s left_kind=%u left_type=%s left_sym=%u left_addr=%u right_kind=%u right_type=%s right_sym=%u right_addr=%u\\n\",",
  "        dkwb_alias_query_ordinal++, dkwb_alias_current_register,",
  "        a0 != 0 ? \"may-alias\" : \"no-alias\",",
  "        MEM_U8(dkwb_left + 0), dkwb_alias_kind(MEM_U8(dkwb_left + 0)),",
  "        MEM_U16(dkwb_left + 4), MEM_U32(dkwb_left + 40),",
  "        MEM_U8(dkwb_right + 0), dkwb_alias_kind(MEM_U8(dkwb_right + 0)),",
  "        MEM_U16(dkwb_right + 4), MEM_U32(dkwb_right + 40));",
  "}",
  "v0 = a0 < 0x1;",
].join("\n"),
  "base-noalias decision"],
  [[
  "t0 = a3 + t6;",
  "v0 = MEM_U32(t0 + 0);",
  "// fdead 400083eb MEM_U32(sp + 44) = s6;",
].join("\n"),
  [
  "t0 = a3 + t6;",
  "v0 = MEM_U32(t0 + 0);",
  "if (dkwb_alias_trace_on()) {",
  "    uint32_t dkwb_kind = MEM_U8(a2 + 0);",
  "    dkwb_alias_current_register = a0;",
  "    fprintf(stderr, \"DKWB-BASE ordinal=%lu reg=%u kind=%u type=%s sym=%u addr=%u hadbase=%u path=%s\\n\",",
  "        dkwb_alias_base_ordinal++, a0, dkwb_kind,",
  "        dkwb_alias_kind(dkwb_kind), MEM_U16(a2 + 4),",
  "        MEM_U32(a2 + 40), v0 != 0,",
  "        (v0 != 0 && dkwb_kind != 1 && dkwb_kind != 5)",
  "            ? \"retain\" : (dkwb_kind == 1 || dkwb_kind == 5 ? \"direct\" : \"fresh\"));",
  "}",
  "// fdead 400083eb MEM_U32(sp + 44) = s6;",
].join("\n"),
  "base-in-register state"],
];

export class AliasInstrumentationResult {
  constructor({ source, input_sha256, profile = "ido-5.3-static-recomp-v12", trace_points = 2 }) {
    Object.assign(this, { source, input_sha256, profile, trace_points });
    Object.freeze(this);
  }
}

function replaceOnce(source, old, replacement, label) {
  const count = source.split(old).length - 1;
  if (count !== 1) throw new ValueError(`uopt alias profile anchor ${strRepr(label)} occurred ${count} times; the generated source does not match this profile`);
  const at = source.indexOf(old);
  return source.slice(0, at) + replacement + source.slice(at + old.length);
}

/** Trace base provenance and base-noalias decisions. */
export function instrumentUoptAlias(source, { allow_unverified_source = false } = {}) {
  if (source.includes(MARKER)) throw new ValueError("source is already instrumented");
  const digest = createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
  if (!allow_unverified_source && digest !== IDO_53_V12_SHA256) {
    throw new ValueError(`source SHA-256 is not the pinned IDO 5.3 static-recomp profile (${digest}); pass --allow-unverified-source only after reviewing the anchors and running a disabled-instrumentation fidelity test`);
  }
  let result = source;
  for (const [old, replacement, label] of ANCHORS) result = replaceOnce(result, old, replacement, label);
  return new AliasInstrumentationResult({ source: result, input_sha256: digest });
}
