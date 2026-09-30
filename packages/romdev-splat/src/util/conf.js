// splat.util.conf: load and merge the yaml config files.
import { readText } from '../runtime.js';
import { loadYaml } from './yaml11.js';
import * as options from './options.js';
import * as vramClasses from './vram_classes.js';
import { isDict, pyTypeName } from './pyfmt.js';

function sameType(a, b) { return pyTypeName(a) === pyTypeName(b); }

export function mergeConfigs(main, additional, additionalPath) {
  for (const key of Object.keys(additional)) {
    if (!(key in main)) {
      main[key] = additional[key];
    } else if (!sameType(main[key], additional[key])) {
      throw new TypeError(`Could not merge ${additionalPath}: type for key '${key}' in configs does not match`);
    } else if (Array.isArray(main[key])) {
      // Python `+=` extends the existing list object in place.
      main[key].push(...additional[key]);
    } else if (isDict(main[key])) {
      main[key] = mergeConfigs(main[key], additional[key], additionalPath);
    } else {
      main[key] = additional[key];
    }
  }
  return main;
}

export function load(configPaths, modes = null, verbose = false, disassembleAll = false, makeFullDisasmForCode = false, overrides = {}) {
  let config = {};
  for (const entry of configPaths) {
    const additional = loadYaml(readText(entry));
    config = mergeConfigs(config, additional, entry);
  }
  vramClasses.initialize(config.vram_classes === undefined ? null : config.vram_classes);
  options.initialize(config, configPaths, modes, verbose, disassembleAll, makeFullDisasmForCode, overrides);
  return config;
}
