// group-listing.js - the bare word of a command group with operations
// (`cache`, `experiment`, `project`, ...). Asked with no operation it prints
// the group's own help listing and succeeds, which is the success path of
// discovery; a group that requires an operation refuses with the usage error
// instead.
//
// Plain JS ESM + JSDoc.

import { formatHelp, formatUsage } from "./argparse.js";

/**
 * The spec for a bare group word. `required` mirrors add_subparsers(
 * required=True): the bare word is then a usage error naming the missing
 * operation; otherwise it prints the listing and exits 0.
 */
export function groupListingSpec(pathWords, { help, description, subcommands, required = false, dest = null }) {
  return {
    path: pathWords, help, description, arguments: [],
    subparsers: { dest: dest ?? `${pathWords.at(-1)}_command`, required },
    handler: (_args, io, ctx) => {
      const prog = `decomp-workbench ${pathWords.join(" ")}`;
      if (required) {
        io.ewrite(formatUsage(ctx.spec, { prog }));
        io.eprint(`${prog}: error: the following arguments are required: ${dest ?? `${pathWords.at(-1)}_command`}`);
        return 2;
      }
      io.write(formatHelp(ctx.spec, { prog }));
      return 0;
    },
  };
}
