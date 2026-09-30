// target-audit-cli.js - `target audit`: the static target-object scope check,
// and the bare `target` group listing.
//
// Plain JS ESM + JSDoc.

import { TARGET_AUDIT_SCHEMA, auditTarget, targetAuditLines } from "./target-audit.js";
import { dumps } from "./pyjson.js";
import { groupListingSpec } from "./group-listing.js";
import { ValueError, pyInt, strRepr, isInputError, osErrorText } from "./py.js";

const VERDICT_EXIT = { ok: 0, warnings: 1, defects: 2 };

const AUDIT_DESCRIPTION = "Verify a campaign/scratch target object's scope before anyone spends "
  + "time matching against it. Static ELF sanity (sections, relocation "
  + "entry counts, symbol table consistency), the literal-pool truncation "
  + "heuristic (a function-owned literal pool externalized and its "
  + "`.rodata` truncated at the jump table boundary to hide it -- the "
  + "exact cef4c defect), and a data-scope report of every undefined "
  + "symbol `.text` reaches through a %hi/%lo pair. --rom/--rom-offset/"
  + "--va add an optional, read-only ROM cross-check: the bytes just past "
  + "the object's own extracted `.rodata` extent, reported so a reader can "
  + "see for themselves whether the pool belongs to the function.";

function parseHex(value, name) {
  try { return pyInt(value, 0); } catch { throw new ValueError(`${name} is not a valid integer: ${strRepr(value)}`); }
}

export function targetAuditCommand(args, io, ctx) {
  let audit;
  try {
    const given = [args.rom, args.rom_offset, args.va];
    if (given.some((v) => v !== null) && !given.every((v) => v !== null)) throw new ValueError("--rom, --rom-offset, and --va must be supplied together, or not at all");
    const romOffset = args.rom_offset !== null ? parseHex(args.rom_offset, "--rom-offset") : null;
    const va = args.va !== null ? parseHex(args.va, "--va") : null;
    audit = auditTarget(args.target, { rom: args.rom, rom_offset: romOffset, va });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(audit.asDict()));
  else io.print(targetAuditLines(audit).join("\n"));
  return VERDICT_EXIT[audit.verdict];
}

const TARGET_DESCRIPTION = "Static checks a target object should pass before a campaign trusts its scope. Run `decomp-workbench target audit --help`.";
const AUDIT_HELP = "verify a target object's ELF scope and literal-pool extent";

export const COMMAND_SPECS = [
  groupListingSpec(["target"], { help: "static checks against a campaign/scratch target object", description: TARGET_DESCRIPTION,
    subcommands: [{ path: ["target", "audit"], help: AUDIT_HELP }] }),
  {
    path: ["target", "audit"], handler: targetAuditCommand, help: AUDIT_HELP, description: AUDIT_DESCRIPTION,
    epilog: "example: decomp-workbench target audit target.o --rom baserom.us.z64 --rom-offset 0x519a4 --va 0x800d5fc4",
    defaults: { report_command: "target-audit" },
    arguments: [
      { dest: "target", help: "the target/candidate object to audit" },
      { flags: ["--rom"], metavar: "FILE", help: "a ROM image to read (read-only) for the optional cross-check. Goes with --rom-offset and --va; supplying one without the others is refused" },
      { flags: ["--rom-offset"], metavar: "HEX", help: "the ROM file offset of the *start* of this object's own extracted `.rodata` -- the same byte --va names. Used to derive where the bytes just past the extracted extent are" },
      { flags: ["--va"], metavar: "HEX", help: "the run-time address --rom-offset corresponds to" },
      { flags: ["--json"], action: "store_true", help: `emit a \`${TARGET_AUDIT_SCHEMA}\` report` },
    ],
  },
];
