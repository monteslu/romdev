// SPDX-License-Identifier: MIT
// romdev-spimdisasm: JavaScript port of spimdisasm (Decompollaborate, MIT).
//
// Mirrors the Python package layout: `common`, `mips`, `elf32` namespaces with
// the same class/function/attribute names. Select the upstream release to
// reproduce with configureVersion() before building any Context/section.

import * as common from "./common/index.js";
import * as mips from "./mips/index.js";
import * as elf32 from "./elf32/index.js";
import { setVersion as setVersionInternal, versionString, versionInfo, SUPPORTED_VERSIONS, RABBITIZER_VERSION_FOR, DEFAULT_VERSION } from "./version.js";
import { rabbitizer, getRabbitizer, setRabbitizer, hasRabbitizer } from "./rabbitizer.js";

export { common, mips, elf32 };
export { SUPPORTED_VERSIONS, RABBITIZER_VERSION_FOR, DEFAULT_VERSION, rabbitizer, setRabbitizer, getRabbitizer, hasRabbitizer };

export const __author__ = "Decompollaborate";

/** Live binding: the configured spimdisasm version string, e.g. "1.42.4". */
export let __version__ = versionString();
/** Live binding: the configured spimdisasm version as [major, minor, patch]. */
export let __version_info__ = versionInfo();

/**
 * Select which upstream spimdisasm release to reproduce ("1.42.4", "1.39.3",
 * "1.35.0"). Resets GlobalConfig and the compiler properties to that release's
 * defaults, so call it before configuring anything else. Also asks the loaded
 * rabbitizer module to switch to the paired rabbitizer release when it
 * supports that.
 */
export function configureVersion(version) {
  setVersionInternal(version);
  __version__ = versionString();
  __version_info__ = versionInfo();

  return { spimdisasm: __version__, rabbitizer: RABBITIZER_VERSION_FOR[__version__] };
}

// Alias of configureVersion (name the splat port probes for).
export { configureVersion as setVersion };

export function getVersion() {
  return versionString();
}
