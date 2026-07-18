// script-grammar — decode a data region as custom bytecode from a DECLARATIVE
// grammar, so a reverse-engineered script format lives in the project (and in
// the tool call) instead of a side decoder script.
//
// Games are full of little interpreters: level/map scripts, entity spawn
// lists, cutscene command streams, music macros. Once the interpreter's
// grammar is verified (each opcode's argument shape), decoding the data is
// mechanical — exactly the part a hand-rolled Python decoder does. This
// module takes the grammar as data:
//
//   {
//     endian: "little" | "big",              // default "little"
//     recordPrefix: [field...],              // read before EVERY record —
//                                            // e.g. a trigger/distance word
//     opcode: { type: "u8" },                // how the command id is read
//     commands: {
//       "0": { name: "SetScrollSpeed", fields: [ {name:"frac",type:"u8"},
//                                                {name:"whole",type:"u8"} ] },
//       "3": { name: "Chain", fields: [ {name:"next",type:"u16",pointer:true} ],
//              stop: true, chain: "next" },
//       ...
//     },
//     unknownOpcode: "stop" | "error",       // default "stop" (with a note)
//   }
//
// Field spec (processed in order; every shape composes):
//   { name, type }                    type: u8|i8|u16|i16|u24|u32
//   { ..., if: {field, mask?, eq|ne} }   present only when (fields[field] &
//                                        mask) equals/not-equals the value —
//                                        mask defaults to "whole byte".
//                                        `default` supplies the implied value
//                                        when the condition fails (reported
//                                        with implied:true, no bytes consumed).
//   { ..., pointer: true }            render as an address (goes in pointers[])
//   { name, repeat: {count: "field" | N}, fields: [...] }
//                                     fixed/counted list of sub-records
//   { name, repeat: {until: {name, type, gte|eq}}, fields: [...] }
//                                     terminated list: read the leading field
//                                     each iteration; if it trips the
//                                     terminator the list ends (terminator
//                                     consumed), else the sub-fields follow.
//
// The conditional test reads from fields ALREADY decoded in the same scope
// (or an enclosing scope), so flag-gated layouts — the common compressed
// form: "bit 7 set means the delay/reload pair is omitted" — are one line.
//
// Decoding is bounds-checked and total: it always returns what it decoded
// plus a machine-readable stop reason, never throws on data (only on a
// malformed GRAMMAR).

/** @typedef {{name: string, type?: string, if?: object, default?: number,
 *             pointer?: boolean, repeat?: object, fields?: object[]}} FieldSpec */

const TYPE_SIZES = { u8: 1, i8: 1, u16: 2, i16: 2, u24: 3, u32: 4 };

class ScriptDecodeEnd extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function readScalar(data, p, type, little) {
  const size = TYPE_SIZES[type];
  if (size == null) throw new Error(`script grammar: unknown field type '${type}' (use ${Object.keys(TYPE_SIZES).join("/")})`);
  if (p + size > data.length) throw new ScriptDecodeEnd("end-of-data");
  let v = 0;
  for (let i = 0; i < size; i++) {
    const byte = data[p + (little ? i : size - 1 - i)];
    v |= byte << (8 * i);
  }
  v >>>= 0;
  if (type === "i8" && v > 0x7f) v -= 0x100;
  if (type === "i16" && v > 0x7fff) v -= 0x10000;
  return { value: v, size };
}

/** Evaluate a field condition against the decoded scopes (innermost first). */
function condHolds(cond, scopes) {
  let val;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (cond.field in scopes[i]) { val = scopes[i][cond.field]; break; }
  }
  if (val == null) throw new Error(`script grammar: condition references '${cond.field}' before it was decoded`);
  const masked = cond.mask != null ? (val & cond.mask) : val;
  if ("eq" in cond) return masked === cond.eq;
  if ("ne" in cond) return masked !== cond.ne;
  throw new Error(`script grammar: condition on '${cond.field}' needs eq or ne`);
}

function resolveCount(spec, scopes) {
  if (typeof spec === "number") return spec;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (spec in scopes[i]) return scopes[i][spec];
  }
  throw new Error(`script grammar: repeat count references '${spec}' before it was decoded`);
}

/**
 * Decode a list of field specs into `out`, returning the new offset.
 * `scopes` is the chain of enclosing decoded-field objects for conditions.
 */
function decodeFields(data, p, specs, little, out, scopes, pointers) {
  for (const spec of specs) {
    if (!spec.name) throw new Error("script grammar: every field needs a name");
    if (spec.if && !condHolds(spec.if, [...scopes, out])) {
      if ("default" in spec) out[spec.name] = { value: spec.default, implied: true };
      continue;
    }
    if (spec.repeat) {
      const items = [];
      if ("count" in spec.repeat) {
        const n = resolveCount(spec.repeat.count, [...scopes, out]);
        for (let i = 0; i < n; i++) {
          const item = {};
          p = decodeFields(data, p, spec.fields ?? [], little, item, [...scopes, out], pointers);
          items.push(item);
        }
      } else if (spec.repeat.until) {
        const t = spec.repeat.until;
        for (;;) {
          const lead = readScalar(data, p, t.type ?? "u8", little);
          p += lead.size;
          if (("gte" in t && lead.value >= t.gte) || ("eq" in t && lead.value === t.eq)) break;
          const item = { [t.name]: lead.value };
          p = decodeFields(data, p, spec.fields ?? [], little, item, [...scopes, out], pointers);
          items.push(item);
        }
      } else {
        throw new Error(`script grammar: repeat on '${spec.name}' needs count or until`);
      }
      out[spec.name] = items;
      continue;
    }
    const { value, size } = readScalar(data, p, spec.type ?? "u8", little);
    p += size;
    out[spec.name] = value;
    if (spec.pointer) pointers.push(value);
  }
  return p;
}

/** Flatten {value, implied} wrappers for compact JSON output. */
function present(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) out[k] = v.map(present);
    else if (v && typeof v === "object" && "implied" in v) out[k] = { value: v.value, implied: true };
    else out[k] = v;
  }
  return out;
}

/**
 * Decode one script stream.
 *
 * @param {Uint8Array} data the region bytes
 * @param {object} grammar see module header
 * @param {object} [opts]
 * @param {number} [opts.startOffset=0] offset of the script start within data
 * @param {number} [opts.baseAddress=0] CPU address of data[0] (addresses in output)
 * @param {number} [opts.maxRecords=256]
 */
export function decodeScript(data, grammar, opts = {}) {
  if (!grammar || typeof grammar !== "object" || !grammar.commands) {
    throw new Error("script grammar: pass {commands: {opcode: {name, fields}}, ...} — see the disasm tool description");
  }
  const little = (grammar.endian ?? "little") === "little";
  const { startOffset = 0, baseAddress = 0, maxRecords = 256 } = opts;
  const opcodeType = grammar.opcode?.type ?? "u8";
  const records = [];
  const pointers = [];
  let p = startOffset;
  let stopped = null;
  const addr = (off) => "$" + (baseAddress + off).toString(16).toUpperCase();

  try {
    while (records.length < maxRecords) {
      if (p >= data.length) { stopped = { reason: "end-of-data", at: addr(p) }; break; }
      const recStart = p;
      const rec = { address: addr(p) };
      if (grammar.recordPrefix?.length) {
        const prefix = {};
        p = decodeFields(data, p, grammar.recordPrefix, little, prefix, [], pointers);
        rec.prefix = present(prefix);
      }
      const op = readScalar(data, p, opcodeType, little);
      p += op.size;
      rec.opcode = op.value;
      const cmd = grammar.commands[String(op.value)] ?? grammar.commands[op.value];
      if (!cmd) {
        if ((grammar.unknownOpcode ?? "stop") === "error") {
          throw new Error(`unknown opcode ${op.value} at ${addr(p - op.size)}`);
        }
        stopped = { reason: "unknown-opcode", opcode: op.value, at: addr(p - op.size) };
        break;
      }
      rec.name = cmd.name ?? `cmd${op.value}`;
      const fields = {};
      p = decodeFields(data, p, cmd.fields ?? [], little, fields, [], pointers);
      if (Object.keys(fields).length) rec.fields = present(fields);
      rec.size = p - recStart;
      records.push(rec);
      if (cmd.stop) {
        stopped = { reason: "stop-command", command: rec.name, at: rec.address };
        if (cmd.chain && fields[cmd.chain] != null) {
          stopped.chainTarget = "$" + Number(fields[cmd.chain]).toString(16).toUpperCase();
        }
        break;
      }
    }
  } catch (e) {
    if (e instanceof ScriptDecodeEnd) {
      stopped = { reason: e.reason, at: addr(p), note: "record truncated by end of region — extend the region or check startOffset" };
    } else {
      throw e;
    }
  }
  if (!stopped) stopped = { reason: "max-records", at: addr(p), note: `stopped after ${maxRecords} records (raise maxRecords to continue)` };

  return {
    records,
    recordCount: records.length,
    stopped,
    bytesConsumed: p - startOffset,
    ...(pointers.length ? { pointers: [...new Set(pointers)].map((v) => "$" + v.toString(16).toUpperCase()) } : {}),
  };
}
