// splat.util.vram_classes
import * as log from './log.js';
import { isDict, isList, isPyInt, pyStr, pyTypeName } from './pyfmt.js';

export class VramClass {
  constructor(name, vram, givenVramSymbol = null, followsClasses = []) {
    this.name = name;
    this.vram = vram;
    this.given_vram_symbol = givenVramSymbol;
    this.follows_classes = followsClasses;
  }

  get vram_symbol() {
    if (this.given_vram_symbol !== null) return this.given_vram_symbol;
    if (this.follows_classes.length) return this.name + '_CLASS_VRAM';
    return null;
  }
}

export const state = { vramClasses: new Map() };

export function initialize(yaml) {
  state.vramClasses = new Map();
  if (yaml === null || yaml === undefined) return;
  if (!isList(yaml)) log.error('vram_classes must be a list');

  const classNames = new Set();
  for (const vc of yaml) {
    if (isDict(vc)) {
      if (!('name' in vc)) log.error(`vram_class (${pyStr(vc)}) must have a name`);
      classNames.add(vc.name);
    } else if (isList(vc)) {
      classNames.add(vc[0]);
    }
  }

  for (const vc of yaml) {
    let name; let vram; let vramSymbol = null; let followsClasses = [];
    if (isDict(vc)) {
      if (!('name' in vc)) log.error(`vram_class (${pyStr(vc)}) must have a name`);
      name = vc.name;
      if (!('vram' in vc)) log.error(`vram_class (${pyStr(vc)}) must have a vram`);
      vram = vc.vram;
      if ('vram_symbol' in vc) {
        vramSymbol = vc.vram_symbol;
        if (typeof vramSymbol !== 'string') {
          log.error(`vram_symbol (${pyStr(vramSymbol)})must be a string, got <class '${pyTypeName(vramSymbol)}'>`);
        }
      }
      if ('follows_classes' in vc) {
        followsClasses = vc.follows_classes;
        if (!isList(followsClasses)) {
          log.error(`vram_symbol (${pyStr(followsClasses)})must be a list, got <class '${pyTypeName(followsClasses)}'>`);
        }
        for (const fc of followsClasses) {
          if (!classNames.has(fc)) log.error(`follows_class (${pyStr(fc)}) not found in vram_classes`);
        }
      }
    } else if (isList(vc)) {
      if (vc.length !== 2) log.error(`vram_class (${pyStr(vc)}) must have 2 elements, got ${vc.length}`);
      name = vc[0];
      vram = vc[1];
    } else {
      log.error(`vram_class must be a dict or list, got <class '${pyTypeName(vc)}'>`);
    }
    if (typeof name !== 'string') log.error(`vram_class name (${pyStr(name)}) must be a string, got <class '${pyTypeName(name)}'>`);
    if (!isPyInt(vram)) log.error(`vram_class vram (${pyStr(vram)}) must be an int, got <class '${pyTypeName(vram)}'>`);
    if (state.vramClasses.has(name)) log.error(`Duplicate vram class name '${name}'`);
    state.vramClasses.set(name, new VramClass(name, vram, vramSymbol, followsClasses));
  }
}

export function resolve(name) {
  if (!state.vramClasses.has(name)) log.error(`Unknown vram class '${pyStr(name)}'`);
  return state.vramClasses.get(name);
}
