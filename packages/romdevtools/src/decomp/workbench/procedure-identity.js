// procedure-identity.js - bind UGEN procedure ordinals to names carried by
// retained Ucode: each Uent is followed by a Ucomm whose payload is the
// procedure name.
//
// Plain JS ESM + JSDoc.

import { ValueError, strRepr } from "./py.js";
import { artifactRecord } from "./evidence.js";

export const PROCEDURE_MAP_SCHEMA = "decomp-workbench-ugen-procedures-v1";
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_.$]*$/;

/** Read each Uent's following procedure-name Ucomm payload exactly. */
export function procedureNames(records) {
  const names = [];
  records.forEach((record, index) => {
    if (record.name !== "ent") return;
    if (index + 1 >= records.length || records[index + 1].name !== "comm") throw new ValueError(`Uent record ${record.index} has no following name Ucomm`);
    const nameRecord = records[index + 1];
    if (nameRecord.words.length < 6) throw new ValueError(`procedure-name Ucomm ${nameRecord.index} is truncated`);
    const length = nameRecord.words[4];
    const payload = Buffer.concat(nameRecord.words.slice(6).map((w) => { const b = Buffer.alloc(4); b.writeUInt32BE(w >>> 0); return b; }));
    if (length < 1 || length > payload.length) throw new ValueError(`procedure-name Ucomm ${nameRecord.index} has invalid length ${length}`);
    let raw = payload.subarray(0, length);
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) end--;
    raw = raw.subarray(0, end);
    if (raw.some((b) => b > 0x7F)) throw new ValueError(`procedure-name Ucomm ${nameRecord.index} is not ASCII`);
    const name = raw.toString("latin1");
    if (!SYMBOL_RE.test(name)) throw new ValueError(`procedure-name Ucomm ${nameRecord.index} is malformed: ${strRepr(name)}`);
    names.push(name);
  });
  if (!names.length) throw new ValueError("retained Ucode contains no named procedures");
  return names;
}

/** A hash-bound ordinal/name map from one complete retained stream. */
export async function procedureMap(ucode, { candidate_object = null } = {}) {
  const { parseUcode } = await import("./ucode.js");
  const names = procedureNames(parseUcode(ucode));
  return {
    schema: PROCEDURE_MAP_SCHEMA,
    procedures: names.map((name, ordinal) => ({ ordinal, name })),
    artifacts: [artifactRecord(ucode, { role: "candidate-ucode" }),
      ...(candidate_object !== null ? [artifactRecord(candidate_object, { role: "candidate-object" })] : [])],
    claim: "Procedure names and ordinals come from the candidate's retained Ucode. They scope candidate UGEN events; they do not infer target allocator events from machine code.",
  };
}

export function selectProcedure(report, symbol) {
  const matches = (report.procedures ?? []).filter((i) => i && typeof i === "object" && i.name === symbol).map((i) => Math.trunc(Number(i.ordinal)));
  if (matches.length !== 1) throw new ValueError(`retained Ucode contains ${matches.length} procedures named ${strRepr(symbol)}`);
  return matches[0];
}
