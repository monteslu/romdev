#!/usr/bin/env node
// romdev-splat CLI, mirroring `splat split`:
//   romdev-splat [split] CONFIG... [--modes M...] [--verbose] [--use-cache]
//     [--skip-version-check] [--stdout-only] [--disassemble-all]
//     [--make-full-disasm-for-code] [--splat-version V|auto]
//     [--spimdisasm-version V|auto] [--cwd DIR] [--base-path DIR]
import { split } from './index.js';

const argv = process.argv.slice(2);
if (argv[0] === 'split') argv.shift();
if (argv[0] === '-V' || argv[0] === '--version') {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  console.log(`romdev-splat ${pkg.version} (splat 0.37.1 / 0.34.1)`);
  process.exit(0);
}

const configs = [];
const o = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    if (i + 1 >= argv.length) { console.error(`${a} needs a value`); process.exit(2); }
    return argv[++i];
  };
  switch (a) {
    case '--modes': {
      o.modes = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.modes.push(argv[++i]);
      break;
    }
    case '--verbose': o.verbose = true; break;
    case '--use-cache': o.useCache = true; break;
    case '--skip-version-check': o.skipVersionCheck = true; break;
    case '--stdout-only': o.stdoutOnly = true; break;
    case '--disassemble-all': o.disassembleAll = true; break;
    case '--make-full-disasm-for-code': o.makeFullDisasmForCode = true; break;
    case '--splat-version': o.splatVersion = val(); break;
    case '--spimdisasm-version': o.spimdisasmVersion = val(); break;
    case '--cwd': o.cwd = val(); break;
    case '--base-path': o.basePath = val(); break;
    case '-h': case '--help':
      console.log('usage: romdev-splat [split] CONFIG [CONFIG ...] [--modes MODES ...] [--verbose] [--use-cache] [--skip-version-check] [--stdout-only] [--disassemble-all] [--make-full-disasm-for-code] [--splat-version V|auto] [--spimdisasm-version V|auto] [--cwd DIR] [--base-path DIR]');
      process.exit(0);
      break;
    default:
      if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
      configs.push(a);
  }
}
if (!configs.length) { console.error('at least one config yaml is required'); process.exit(2); }

const r = await split(configs, { ...o, onOutput: (stream, text) => (stream === 'stderr' ? process.stderr : process.stdout).write(text) });
process.exitCode = r.exitCode;
