// romdev-core-host — the isomorphic core surface. Everything exported here
// (and its static import closure) is browser-bundleable: no top-level `node:`
// imports, no pngjs. PNG encode/crop/resample: romdev-core-host/framebuffer-png.js.
// The Node I/O adapter (path-based loads): romdev-core-host/io-node.js (lazy).
export { LibretroHost } from "./LibretroHost.js";
export { framebufferToRgba, decodePixelsInto } from "./framebuffer.js";
export { extnameOf, isNodeEnv, encodeCString, writeFsTree } from "./pure-util.js";
export * from "./retroConstants.js";
export * from "./types.js";
