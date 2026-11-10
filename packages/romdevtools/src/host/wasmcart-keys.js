// Keyboard names for wasmcart carts: SDL scancode names (what SDL_GetScancodeName
// prints, lowercased) and a few common aliases, resolved to the USB HID usage
// ids the wasmcart keyboard ABI carries (SPEC.md "Keyboard Input": the 256-bit
// held mask behind wc_info_t.keys_ptr and the wc_kb_on_down/up events). A real
// host (wasmcart-play on SDL, the web host on KeyboardEvent.code) delivers the
// same ids, so a cart's bindings (`key:space`, `key:w`) are driven here exactly
// as a player's keyboard drives them.

const NAMES = new Map();
const name = (code, ...names) => { for (const n of names) NAMES.set(n, code); };

for (let i = 0; i < 26; i++) name(4 + i, String.fromCharCode(97 + i));
for (let i = 1; i <= 9; i++) name(29 + i, String(i));
name(39, "0");
name(40, "return", "enter");
name(41, "escape", "esc");
name(42, "backspace");
name(43, "tab");
name(44, "space", "spacebar");
name(45, "-", "minus");
name(46, "=", "equals", "equal");
name(47, "[", "leftbracket", "lbracket");
name(48, "]", "rightbracket", "rbracket");
name(49, "\\", "backslash");
name(50, "#", "nonushash", "hash");
name(51, ";", "semicolon");
name(52, "'", "apostrophe", "quote");
name(53, "`", "grave", "backquote");
name(54, ",", "comma");
name(55, ".", "period");
name(56, "/", "slash");
name(57, "capslock");
for (let i = 1; i <= 12; i++) name(57 + i, "f" + i);
name(70, "printscreen");
name(71, "scrolllock");
name(72, "pause");
name(73, "insert");
name(74, "home");
name(75, "pageup", "pgup");
name(76, "delete", "del");
name(77, "end");
name(78, "pagedown", "pgdn");
name(79, "right", "arrowright");
name(80, "left", "arrowleft");
name(81, "down", "arrowdown");
name(82, "up", "arrowup");
name(83, "numlock", "numlockclear");
name(84, "keypad/", "kpdivide", "kp/");
name(85, "keypad*", "kpmultiply", "kp*");
name(86, "keypad-", "kpminus", "kp-");
name(87, "keypad+", "kpplus", "kp+");
name(88, "keypadenter", "kpenter");
for (let i = 1; i <= 9; i++) name(88 + i, "keypad" + i, "kp" + i);
name(98, "keypad0", "kp0");
name(99, "keypad.", "kpperiod", "kp.");
name(100, "nonusbackslash");
name(101, "application", "menu");
name(102, "power");
name(103, "keypad=", "kpequals", "kp=");
for (let i = 13; i <= 24; i++) name(104 + i - 13, "f" + i);
name(224, "leftctrl", "lctrl", "ctrl", "control");
name(225, "leftshift", "lshift", "shift");
name(226, "leftalt", "lalt", "alt");
name(227, "leftgui", "lgui", "gui", "meta", "super", "win", "cmd", "command");
name(228, "rightctrl", "rctrl");
name(229, "rightshift", "rshift");
name(230, "rightalt", "ralt", "altgr");
name(231, "rightgui", "rgui");

/** wc_kb_on_down/up modifier bits (SPEC.md WC_MOD_*). */
export const MOD = { SHIFT: 0x01, CTRL: 0x02, ALT: 0x04, META: 0x08 };
const MOD_OF_CODE = new Map([[224, MOD.CTRL], [228, MOD.CTRL], [225, MOD.SHIFT], [229, MOD.SHIFT], [226, MOD.ALT], [230, MOD.ALT], [227, MOD.META], [231, MOD.META]]);

/** The names this table knows, for an error message. */
export const KEY_NAMES = [...new Set(NAMES.keys())];

/**
 * One key spelling to its scancode: a name from the table (case does not
 * matter; spaces, underscores and hyphens inside a name are ignored, so
 * "Left Shift", "left_shift" and "lshift" are the same key) or a number that
 * already is a scancode (0-255). Unknown names throw, naming the key.
 */
export function keyScancode(key) {
  if (typeof key === "number") {
    if (!Number.isInteger(key) || key < 0 || key > 255) throw new Error(`key ${key}: a numeric key is a USB HID scancode 0-255`);
    return key;
  }
  if (typeof key !== "string" || !key.length) throw new Error(`key ${JSON.stringify(key)}: a key is a name such as 'space', 'w', 'return', 'left', 'lshift' or a scancode number`);
  const raw = key.toLowerCase();
  const code = NAMES.get(raw) ?? (raw.length > 1 ? NAMES.get(raw.replace(/[\s_-]+/g, "")) : undefined);
  if (code === undefined) throw new Error(`unknown key '${key}' (names: a-z, 0-9, f1-f24, space, return, escape, tab, backspace, left/right/up/down, lshift, lctrl, lalt, ... the SDL scancode names; or a scancode number)`);
  return code;
}

/** A list of key spellings to a sorted list of distinct scancodes. */
export function keyScancodes(keys) {
  if (keys == null) return [];
  if (!Array.isArray(keys)) throw new Error("`keys` must be an array of key names (['space', 'w']) or scancode numbers");
  return [...new Set(keys.map(keyScancode))].sort((a, b) => a - b);
}

/** The WC_MOD_* bitmask a held set of scancodes implies. */
export function modifiersOf(codes) {
  let m = 0;
  for (const c of codes) m |= MOD_OF_CODE.get(c) ?? 0;
  return m;
}

/** The SDL name of a scancode (the first name in the table), or the number. */
export function keyName(code) {
  for (const [n, c] of NAMES) if (c === code) return n;
  return code;
}
