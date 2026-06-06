// clusterChanges — turn a flat list of changed byte offsets into a context-safe
// summary: adjacent changes merge into ranges, and evenly-spaced ranges report
// their stride. The trap this kills: a 20-frame gameplay diff churns thousands
// of bytes and a raw {offset,before,after} dump blows the token budget. The
// summary says "4 change-islands at stride 0x80 — likely a player-struct array"
// in a few rows instead, which is also the more USEFUL answer (the stride is the
// record size of an entity array — exactly what an RE session is hunting for).

/**
 * Group changed absolute offsets into clusters and detect a uniform stride.
 * @param {number[]} absOffsets changed offsets (ABSOLUTE, ascending), e.g. baseOffset + i
 * @param {object} [opts]
 * @param {number} [opts.gap=4] merge two changes into one cluster if within this many bytes
 * @returns {{ clusters: {startDec:number,endDec:number,bytes:number}[], stride: number|null }}
 */
export function clusterChanges(absOffsets, opts = {}) {
  const gap = opts.gap ?? 4;
  const clusters = [];
  for (const abs of absOffsets) {
    const last = clusters[clusters.length - 1];
    if (last && abs - last.endDec <= gap) { last.endDec = abs; last.bytes++; }
    else clusters.push({ startDec: abs, endDec: abs, bytes: 1 });
  }
  // Stride: clusters' start offsets evenly spaced ⇒ struct/entity array.
  let stride = null;
  if (clusters.length >= 3) {
    const deltas = [];
    for (let i = 1; i < clusters.length; i++) deltas.push(clusters[i].startDec - clusters[i - 1].startDec);
    if (deltas.every((d) => d === deltas[0]) && deltas[0] > 0) stride = deltas[0];
  }
  return { clusters, stride };
}
