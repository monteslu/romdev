// GBC song compiler — GBC uses the same hUGEDriver as GB, so the song format and
// note math are identical. Re-export the GB compiler.
export { compileSong, noteToHugeIndex, HUGE_ROWS_PER_PATTERN, default } from "../gb/song.js";
