// romdev-famitone — pure-JS FamiTone2 music compiler for the NES.
//
// A faithful port of Shiru's `text2data` tool (nesdoug bug-fix fork): it parses
// a FamiTracker `.txt` export and emits FamiTone2-format music data as ca65
// `.s` source that you assemble with the bundled FamiTone2 driver and play on
// the NES APU. No native binary.
//
//   text (.txt) ──parse-txt.js──► song model ──emit-ft2.js──► ca65 .s
//
// Typical use:
//   import { emitFamiTone2 } from 'romdev-famitone';
//   const asm = emitFamiTone2(famitrackerTxt, { name: 'mysong' });
//
// `emitFamiTone2` accepts the raw `.txt` string directly (it parses for you);
// pass a parsed model from `parseFamiTrackerTxt` if you want to inspect the
// song first.

export { emitFamiTone2, emitFt2, default as default } from './emit-ft2.js';

export {
  parseFamiTrackerTxt,
  isFamiTrackerTextExport,
  FamiTrackerParseError,
} from './parse-txt.js';
