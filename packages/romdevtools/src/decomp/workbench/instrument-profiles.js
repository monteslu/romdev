// instrument-profiles.js - composition of guarded instrumentation profiles
// for IDO 5.3 uopt (instrument-uopt): one input validation, then each
// requested profile in a fixed order so repeated runs and source diffs are
// reproducible.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { ValueError } from "./py.js";
import { instrumentUoptAlias } from "./instrument-alias.js";
import { IDO_53_V12_SHA256, instrumentUoptGlobalcolor } from "./instrument-uopt.js";

export const SUPPORTED_PROFILES = Object.freeze(["alias", "globalcolor"]);

export class UoptProfilesResult {
  constructor({ source, input_sha256, profiles, trace_points, profile = "ido-5.3-static-recomp-v12" }) {
    Object.assign(this, { source, input_sha256, profiles, trace_points, profile });
    Object.freeze(this);
  }
}

/** Apply one or more compatible profiles after one input validation. */
export function instrumentUoptProfiles(source, profiles, { allow_unverified_source = false } = {}) {
  const requested = [...new Set(profiles)];
  if (!requested.length) throw new ValueError("select at least one uopt instrumentation profile");
  const unknown = requested.filter((p) => !SUPPORTED_PROFILES.includes(p)).sort();
  if (unknown.length) throw new ValueError("unknown uopt profile(s): " + unknown.join(", ") + "; expected alias or globalcolor");
  const digest = createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
  if (!allow_unverified_source && digest !== IDO_53_V12_SHA256) {
    throw new ValueError(`source SHA-256 is not the pinned IDO 5.3 static-recomp profile (${digest}); pass --allow-unverified-source only after reviewing every anchor and running a disabled-instrumentation fidelity test`);
  }
  const ordered = SUPPORTED_PROFILES.filter((p) => requested.includes(p));
  let instrumented = source, tracePoints = 0;
  for (const profile of ordered) {
    const r = profile === "alias" ? instrumentUoptAlias(instrumented, { allow_unverified_source: true }) : instrumentUoptGlobalcolor(instrumented, { allow_unverified_source: true });
    instrumented = r.source;
    tracePoints += r.trace_points;
  }
  return new UoptProfilesResult({ source: instrumented, input_sha256: digest, profiles: ordered, trace_points: tracePoints });
}
