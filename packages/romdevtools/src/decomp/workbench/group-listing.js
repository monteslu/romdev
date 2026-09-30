// group-listing.js - the bare word of a command group with operations
// (`cache`, `experiment`, `project`, ...). Asked with no operation it prints
// the group's own help listing and succeeds, which is the success path of
// discovery; a group that requires an operation refuses with the usage error
// instead.
//
// Plain JS ESM + JSDoc.

import { ArgumentError } from "./argparse.js";

function wrap(text, width) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** Help text for a group parser listing its operations. */
export function groupHelp(pathWords, { description, subcommands }) {
  const names = subcommands.map((s) => s.path.at(-1));
  const choice = `{${names.join(",")}}`;
  let out = `usage: decomp-workbench ${pathWords.join(" ")} [-h] ${choice} ...\n`;
  if (description) out += "\n" + wrap(description, 78).join("\n") + "\n";
  out += "\npositional arguments:\n";
  out += `  ${choice}\n`;
  for (const s of subcommands) {
    const name = s.path.at(-1);
    const helpLines = wrap(s.help, 54);
    if (name.length <= 18) out += `    ${name.padEnd(20)}${helpLines[0] ?? ""}\n`;
    else out += `    ${name}\n` + (helpLines[0] ? `${" ".repeat(24)}${helpLines[0]}\n` : "");
    out += helpLines.slice(1).map((l) => " ".repeat(24) + l + "\n").join("");
  }
  out += "\noptions:\n  -h, --help            show this help message and exit\n";
  return out;
}

/**
 * The spec for a bare group word. `required` mirrors add_subparsers(
 * required=True): the bare word is then a usage error naming the missing
 * operation; otherwise it prints the listing and exits 0.
 */
export function groupListingSpec(pathWords, { help, description, subcommands, required = false, dest = null }) {
  return {
    path: pathWords, help, description, arguments: [],
    handler: (_args, io) => {
      if (required) {
        const e = new ArgumentError(`the following arguments are required: ${dest ?? `${pathWords.at(-1)}_command`}`);
        io.eprint(`usage: decomp-workbench ${pathWords.join(" ")} [-h] {${subcommands.map((s) => s.path.at(-1)).join(",")}} ...`);
        io.eprint(`decomp-workbench ${pathWords.join(" ")}: error: ${e.message}`);
        return 2;
      }
      io.write(groupHelp(pathWords, { description, subcommands }));
      return 0;
    },
  };
}
