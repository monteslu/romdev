// discovery-cli.js - `commands` (the journey map), `completion` (shell
// completion scripts generated from the live grammar) and the bare group
// words (`object`, `trace`, ...) that print their part of the map.
//
// Plain JS ESM + JSDoc.

import { COMMAND_MAP, GROUP_ALIASES, HIDDEN_FLAT_COMMANDS, commandMapPayload, renderCommandMap } from "./discovery.js";
import { dumps } from "./pyjson.js";

export function commandsCommand(args, io) {
  if (args.json) io.print(dumps(commandMapPayload()));
  else io.print(renderCommandMap({ group: args.group }).join("\n"));
  return 0;
}

async function liveOptions() {
  const { commandSpecs } = await import("./cli.js");
  const specs = await commandSpecs();
  const optionsOf = (spec) => [...(spec ? spec.arguments.filter((a) => Array.isArray(a.flags)).flatMap((a) => a.flags) : []), "-h", "--help"].sort();
  const top = [...specs.values()].filter((s) => s.path.length === 1);
  const commands = top.map((s) => s.path[0]).filter((n) => !HIDDEN_FLAT_COMMANDS.has(n)).sort();
  const options = Object.fromEntries(top.map((s) => [s.path[0], optionsOf(s)]));
  const operationOptions = [];
  for (const [group, ops] of Object.entries(COMMAND_MAP)) {
    for (const [op] of ops) {
      const alias = GROUP_ALIASES[`${group} ${op}`];
      const spec = alias ? specs.get(alias) : specs.get(`${group} ${op}`);
      operationOptions.push([group, op, spec ? optionsOf(spec) : []]);
    }
  }
  const operations = Object.fromEntries(Object.entries(COMMAND_MAP).map(([g, l]) => [g, l.map(([c]) => c).join(" ")]));
  return { commands, options, operationOptions, operations };
}

/** A dependency-free completion script generated from the live grammar. */
export async function renderCompletion(shell) {
  const { commands, options, operationOptions, operations } = await liveOptions();
  const q = JSON.stringify;
  const words = commands.join(" ");
  if (shell === "bash") {
    const optionCases = Object.entries(options).map(([n, v]) => `    ${n}) opts=${q(v.join(" "))} ;;`).join("\n");
    const operationCases = Object.entries(operations).map(([g, v]) => `    ${g}) ops=${q(v)} ;;`).join("\n");
    const nested = operationOptions.map(([g, o, v]) => `    ${g}:${o}) opts=${q(v.join(" "))} ;;`).join("\n");
    return `_decomp_workbench() {
  local cur cmd op ops opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W ${q(words)} -- "$cur") )
    return
  fi
  cmd="\${COMP_WORDS[1]}"
  case "$cmd" in
${operationCases}
  esac
  if [[ -n $ops ]]; then
    if [[ $COMP_CWORD -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "$ops" -- "$cur") )
      return
    fi
    op="\${COMP_WORDS[2]}"
    case "$cmd:$op" in
${nested}
    esac
  else
  case "$cmd" in
${optionCases}
  esac
  fi
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _decomp_workbench decomp-workbench
`;
  }
  if (shell === "zsh") {
    const operationCases = Object.entries(operations).map(([g, v]) => `    ${g}) ops=(` + v.split(" ").map((x) => q(x)).join(" ") + ") ;;").join("\n");
    const optionCases = Object.entries(options).map(([n, v]) => `    ${n}) opts=(${v.map((x) => q(x)).join(" ")}) ;;`).join("\n");
    const nested = operationOptions.map(([g, o, v]) => `    ${g}:${o}) opts=(` + v.map((x) => q(x)).join(" ") + ") ;;").join("\n");
    return `#compdef decomp-workbench
_decomp_workbench() {
  local -a commands ops opts
  local cmd op
  commands=(${commands.map((x) => q(x)).join(" ")})
  if (( CURRENT == 2 )); then
    compadd -- $commands
    return
  fi
  cmd=$words[2]
  case "$cmd" in
${operationCases}
  esac
  if (( \${#ops} )); then
    if (( CURRENT == 3 )); then
      compadd -- $ops
      return
    fi
    op=$words[3]
    case "$cmd:$op" in
${nested}
    esac
  else
    case "$cmd" in
${optionCases}
    esac
  fi
  compadd -- $opts
}
compdef _decomp_workbench decomp-workbench
`;
  }
  if (shell === "fish") {
    const lines = ["complete -c decomp-workbench -f", ...commands.map((c) => `complete -c decomp-workbench -n '__fish_use_subcommand' -a ${q(c)}`)];
    for (const [g, ops] of Object.entries(operations)) {
      const cond = `__fish_seen_subcommand_from ${g}; and not __fish_seen_subcommand_from ${ops}`;
      lines.push(`complete -c decomp-workbench -n ${q(cond)} -a ${q(ops)}`);
    }
    for (const [g, o, v] of operationOptions) {
      if (!v.length) continue;
      const cond = `__fish_seen_subcommand_from ${g}; and __fish_seen_subcommand_from ${o}`;
      lines.push(`complete -c decomp-workbench -n ${q(cond)} -a ${q(v.join(" "))}`);
    }
    return lines.join("\n") + "\n";
  }
  if (shell === "powershell") {
    const choices = commands.map((c) => `'${c}'`).join(", ");
    const groupCases = Object.entries(operations).map(([g, v]) => `    '${g}' { $choices = @(` + v.split(" ").map((x) => `'${x}'`).join(", ") + ") }").join("\n");
    const nested = operationOptions.filter(([, , v]) => v.length).map(([g, o, v]) => `    '${g}:${o}' { $choices = @(` + v.map((x) => `'${x}'`).join(", ") + ") }").join("\n");
    return `Register-ArgumentCompleter -Native \`
  -CommandName decomp-workbench -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $choices = @(${choices})
  if ($tokens.Count -ge 2) {
    switch ($tokens[1]) {
${groupCases}
    }
  }
  if ($tokens.Count -ge 3) {
    $operation = "$($tokens[1]):$($tokens[2])"
    switch ($operation) {
${nested}
    }
  }
  $choices | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
}
`;
  }
  throw new Error(`unsupported shell: ${shell}`);
}

/** Journey-map entries absent from the live grammar (the registry seam). */
export async function commandRegistryErrors() {
  const { commandSpecs } = await import("./cli.js");
  const specs = await commandSpecs();
  const errors = [];
  for (const [group, entries] of Object.entries(COMMAND_MAP)) {
    if (![...specs.keys()].some((k) => k === group || k.startsWith(`${group} `))) errors.push(`missing command group: ${group}`);
    for (const [op] of entries) {
      const alias = GROUP_ALIASES[`${group} ${op}`];
      if (alias) { if (!specs.has(alias)) errors.push(`${group} ${op} aliases missing command ${alias}`); }
      else if (!specs.has(`${group} ${op}`)) errors.push(`missing grouped command: ${group} ${op}`);
    }
  }
  return errors;
}

const GROUP_WORDS = ["object", "scratch", "handoff", "note", "probe", "sweep", "trace", "instrument", "pass", "capture", "ucode", "binasm", "stream", "toolchain"];

export const COMMAND_SPECS = [
  { path: ["commands"], handler: commandsCommand, help: "show the compact journey-oriented command map",
    arguments: [{ flags: ["--group"], choices: Object.keys(COMMAND_MAP).sort() }, { flags: ["--json"], action: "store_true", help: "emit JSON" }] },
  { path: ["completion"], help: "generate shell completion from the live command parser",
    arguments: [{ dest: "shell", choices: ["bash", "zsh", "fish", "powershell"] }],
    handler: async (args, io) => { try { io.write(await renderCompletion(args.shell)); return 0; } catch (e) { io.eprint(`error: ${e.message}`); return 2; } } },
  ...GROUP_WORDS.filter((g) => COMMAND_MAP[g]).map((group) => {
    const entries = COMMAND_MAP[group];
    const width = Math.max(...entries.map(([c]) => c.length));
    return {
      path: [group], help: `${group} journey commands; run without arguments for a map`,
      description: "Grouped spellings and existing flat commands are both supported.",
      epilog: entries.map(([c, d]) => `  ${group} ${c.padEnd(width)}  ${d}`).join("\n"),
      formatter: "raw_description",
      arguments: [],
      handler: (_args, io) => { io.print(renderCommandMap({ group }).join("\n")); return 0; },
    };
  }),
];
