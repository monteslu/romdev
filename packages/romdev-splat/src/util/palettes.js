// splat.util.palettes: resolve Raster#palette and Palette#raster links.
import * as log from './log.js';

function isPalette(s) { return typeof s.parse_palette === 'function' && 'global_id' in s; }
function isCi(s) { return Array.isArray(s.palette_names); }

export function initialize(allSegments) {
  const globalIds = new Map();

  const collectGlobalIds = (segments) => {
    for (const segment of segments) {
      if (isPalette(segment) && segment.global_id !== null) globalIds.set(segment.global_id, segment);
      if (segment.isGroup) collectGlobalIds(segment.subsegments);
    }
  };

  const globalIdsNotSeen = new Set();

  const process = (segments) => {
    const rasterMap = new Map();
    const paletteMap = new Map();
    for (const segment of segments) {
      if (isPalette(segment)) paletteMap.set(segment.name, segment);
      if (isCi(segment)) rasterMap.set(segment.name, segment);
      if (segment.isGroup) process(segment.subsegments);
    }
    const palettesSeen = new Set(paletteMap.keys());
    for (const raster of rasterMap.values()) {
      for (const palName of raster.palette_names) {
        let pal = globalIds.has(palName) ? globalIds.get(palName) : null;
        if (pal !== null) {
          globalIdsNotSeen.delete(palName);
          palettesSeen.delete(palName);
          raster.palettes.push(pal);
        } else {
          pal = paletteMap.has(palName) ? paletteMap.get(palName) : null;
          if (pal !== null) {
            palettesSeen.delete(palName);
            raster.palettes.push(pal);
          } else {
            log.error('Could not find palette: ' + palName + ', referenced by raster: ' + raster.name);
          }
        }
      }
      for (const palName of paletteMap.keys()) {
        if (palName.startsWith(raster.name + '.')) {
          raster.palettes.push(paletteMap.get(palName));
          palettesSeen.delete(palName);
        }
      }
      if (raster.palettes.length === 0) log.error(`Raster ${raster.name} has no linked palettes`);
    }
    for (const palName of palettesSeen) {
      const pal = paletteMap.get(palName);
      if (pal.global_id === null) log.error(`Palette ${pal.name} has no linked rasters`);
    }
  };

  collectGlobalIds(allSegments);
  for (const k of globalIds.keys()) globalIdsNotSeen.add(k);
  process(allSegments);
  if (globalIdsNotSeen.size > 0) {
    log.error(`Found no ci links to palettes with global_ids: ${[...globalIdsNotSeen].join(', ')}`);
  }
}
