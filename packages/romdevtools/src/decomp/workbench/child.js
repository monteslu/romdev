// child.js - runs one workbench command in its own node process, with the
// project directory as the working directory, so relative paths and error
// messages read exactly as they do from a shell in that directory. The parent
// (cli.js runCommandIsolated) enforces the timeout by killing this process
// group.
//
// Plain JS ESM + JSDoc.

import { runCommand } from "./cli.js";

process.on("message", async (m) => {
  if (m?.type !== "run") return;
  let result;
  try {
    result = await runCommand(m.argv, { cwd: process.cwd(), env: m.env ?? {} });
  } catch (e) {
    result = { code: 2, stdout: "", stderr: `error: ${e?.stack ?? e}\n` };
  }
  process.send({ type: "result", ...result }, () => process.exit(0));
});
