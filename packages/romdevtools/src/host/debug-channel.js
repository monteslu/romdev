// A wasmcart cart's debug channel (the convention behind wasm({op:'command'})):
// bytes fields dbg.cmd / dbg.reply and u32 fields dbg.cmd_seq, dbg.reply_seq,
// dbg.reply_len in the cart's debug table. The host writes the request and
// bumps cmd_seq; the cart answers at the start of its next frame.
//
// Split in two so a caller that is already running frames (a timing run) can
// post a request before a frame and read the reply after it, without an extra
// frame: postDebugCommand() then takeDebugReply().
//
// Plain JS ESM + JSDoc.

const FIELDS = ["dbg.cmd", "dbg.cmd_seq", "dbg.reply", "dbg.reply_seq", "dbg.reply_len"];

/** The channel's fields, or throws naming what is missing. */
function channel(host) {
  const fields = host.readDebugState?.() ?? [];
  const f = (n) => fields.find((x) => x.name === n);
  const missing = FIELDS.filter((n) => !f(n));
  if (missing.length) {
    throw new Error(`this cart has no debug channel (missing ${missing.join(", ")} in its debug table). The cart has to be built with its debug channel enabled.`);
  }
  return { cmd: f("dbg.cmd"), reply: f("dbg.reply") };
}

/** True when the loaded cart has a debug channel. */
export function hasDebugChannel(host) {
  try { channel(host); return true; } catch { return false; }
}

/**
 * Write `text` to the channel. The cart answers on its next frame.
 * @returns {number} the request's sequence number
 */
export function postDebugCommand(host, text) {
  const { cmd } = channel(host);
  const bytes = Buffer.from(text + "\0", "utf8");
  if (bytes.length > cmd.len) throw new Error(`debug command is ${bytes.length} bytes; the cart's dbg.cmd holds ${cmd.len}.`);
  const seq = ((host.readDebugValue("dbg.cmd_seq").value >>> 0) + 1) >>> 0;
  host.writeMemory(cmd.valuePtr, new Uint8Array(bytes));
  host.writeDebugValue("dbg.cmd_seq", seq);
  return seq;
}

/**
 * The reply to request `seq`, or undefined when the cart has not answered
 * yet. Parsed as JSON when it is JSON.
 */
export function takeDebugReply(host, seq) {
  if ((host.readDebugValue("dbg.reply_seq").value >>> 0) !== seq) return undefined;
  const { reply } = channel(host);
  const len = host.readDebugValue("dbg.reply_len").value >>> 0;
  const text = Buffer.from(host.readMemory(reply.valuePtr, Math.min(len, reply.len))).toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Send one command and step frames until it is answered (at most maxFrames).
 * @returns {Promise<{framesRun:number, reply:any}>}
 */
export async function runDebugCommand(host, text, maxFrames = 8) {
  const seq = postDebugCommand(host, text);
  let frames = 0, reply;
  while ((reply = takeDebugReply(host, seq)) === undefined && frames < maxFrames) {
    await host.stepFrames(1);
    frames++;
  }
  if (reply === undefined) {
    throw new Error(`debug command '${text}': no reply after ${frames} frames (is the cart paused by the host, or not processing its debug channel?).`);
  }
  return { framesRun: frames, reply };
}
