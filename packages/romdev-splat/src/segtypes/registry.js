// Segment type lookup tables (filled in by segtypes/index.js) and the
// extension loader hook; kept separate so segment.js has no import cycles.
export const registry = {
  common: {},
  platform: { n64: {}, psx: {}, ps2: {}, psp: {} },
  LinkerEntry: null,
  loadExtension: () => null,
};
