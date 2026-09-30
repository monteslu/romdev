// Run a workbench command in process and hand back [status, stdout, stderr],
// the triple the workbench's own tests assert on.
import { runCommand } from "../../../src/decomp/workbench/cli.js";

export async function runCli(argv, { cwd = process.cwd(), env = {} } = {}) {
  const r = await runCommand(argv, { cwd, env });
  return [r.code, r.stdout, r.stderr];
}
