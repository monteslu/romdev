// systray.js - `romdev-permuter-remote run-server --systray`, a port of RealSystrayState from
// decomp-permuter's src/net/cmd/run_server.py. The tray itself is upstream's
// external helper (src/net/cmd/systray/tray.go, built with Go), driven over
// newline-delimited JSON on its stdin/stdout. romdev does not ship that binary:
// point $ROMDEV_PAH_SYSTRAY at it, or put it at <package>/systray/permuter-systray.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SystrayState } from "./server.js";

const CLIENT_SLOTS = 10;
const UPDATE_INTERVAL = 2.0;
const MENU_TOOLTIP = "permuter@home";

export function systrayHelperPath() {
  if (process.env.ROMDEV_PAH_SYSTRAY) return process.env.ROMDEV_PAH_SYSTRAY;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const p = fileURLToPath(new URL(`../../systray/permuter-systray${suffix}`, import.meta.url));
  return existsSync(p) ? p : null;
}

export class RealSystrayState extends SystrayState {
  /** Resolves once the helper reports ready. */
  static async create(io_queue) {
    const s = new RealSystrayState(io_queue);
    await s._ready;
    return s;
  }

  constructor(io_queue) {
    super();
    this._io_queue = io_queue;
    this._permuters = new Map();
    this._onclick = new Map();
    this._status = "connecting";
    this._fail_message = null;
    const icon = (f) => readFileSync(fileURLToPath(new URL(`./icons/${f}`, import.meta.url))).toString("base64");
    this._icons = { working: icon("okthink.ico"), passive: icon("ok.ico"), fail: icon("notok.ico") };
    this._current_icon = "working";
    let next_id = 100;
    const add_item = (menu, title, onclick = null, { submenu = null, hidden = false } = {}) => {
      next_id += 1;
      const obj = { title, enabled: onclick != null || submenu != null, hidden, __id: next_id };
      if (onclick) this._onclick.set(next_id, onclick);
      if (submenu) obj.items = submenu;
      menu.push(obj);
      return next_id;
    };
    const menu = [];
    this._status_id = add_item(menu, "Connecting...");
    this._client_slots = [];
    for (let i = 0; i < CLIENT_SLOTS; i++) {
      const submenu = [];
      const iterations_id = add_item(submenu, "");
      const improvements_id = add_item(submenu, "");
      const stop_id = add_item(submenu, "Stop", () => this._remove_permuter(i));
      const menu_id = add_item(menu, "", null, { submenu, hidden: true });
      this._client_slots.push({ menu_id, iterations_id, improvements_id, stop_id, permuter: null });
    }
    this._more_id = add_item(menu, "", null, { hidden: true });
    add_item(menu, "Quit", () => this._io_queue.put([null, { kind: "shutdown" }]));

    const helper = systrayHelperPath();
    if (!helper) {
      throw new Error("An external helper binary is required for systray support.\n" +
        "Build it from decomp-permuter's src/net/cmd/systray (requires Go), then set\n" +
        "ROMDEV_PAH_SYSTRAY to its path or place it at romdev-permuter/systray/permuter-systray.");
    }
    this._proc = spawn(helper, [], { stdio: ["pipe", "pipe", "inherit"] });
    this._exited = new Promise((r) => this._proc.on("exit", r));
    const rl = createInterface({ input: this._proc.stdout });
    let first = true;
    this._ready = new Promise((resolve, reject) => {
      this._proc.on("error", reject);
      rl.on("line", (line) => {
        let resp;
        try { resp = JSON.parse(line); } catch { reject(new Error(`Failed to parse systray JSON: ${line}`)); return; }
        if (first) {
          first = false;
          if (resp?.type === "ready") resolve();
          else reject(new Error("Failed to initialize systray!"));
          return;
        }
        if (resp.type === "clicked") this._onclick.get(resp.__id)?.();
      });
      rl.on("close", () => { if (first) reject(new Error("Failed to initialize systray!")); });
    });
    this._send({ icon: this._icons[this._current_icon], tooltip: MENU_TOOLTIP, items: menu });
  }

  _send(msg) { try { this._proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* helper gone */ } }

  _update_item(id, title, { hidden = false, enabled = false } = {}) {
    this._send({ type: "update-item", item: { title, enabled, hidden, __id: id }, seq_id: -1 });
  }

  _remove_permuter(slot_index) {
    const slot = this._client_slots[slot_index];
    if (!slot.permuter) return;
    this._io_queue.put([null, [slot.permuter, { kind: "user_remove" }]]);
  }

  _update_permuter(perm, slot) {
    this._update_item(slot.iterations_id, `Iterations: ${perm.iterations}`);
    this._update_item(slot.improvements_id, `Improvements found: ${perm.improvements}`);
  }

  _update_status() {
    let status, icon;
    if (this._status === "connecting") { status = "Reconnecting..."; icon = "working"; }
    else if (this._status === "reconnecting") { status = "Disconnected, will reconnect..."; icon = "fail"; }
    else if (this._status === "connected") {
      if (this._permuters.size) { status = "Currently permuting:"; icon = "working"; }
      else { status = "Not running"; icon = "passive"; }
    } else {
      status = this._fail_message ? `Error: ${this._fail_message}` : "Error occurred";
      icon = "fail";
    }
    this._update_item(this._status_id, status);
    if (this._current_icon !== icon) {
      this._current_icon = icon;
      this._send({ type: "update-menu", menu: { tooltip: MENU_TOOLTIP, icon: this._icons[icon] } });
    }
  }

  _fill_slots() {
    let has_more = false;
    for (;;) {
      let key = null;
      for (const [k, p] of this._permuters) if (p.slot == null) { key = k; break; }
      if (key == null) break;
      let chosen = null;
      for (let i = CLIENT_SLOTS - 1; i >= 0; i--) {
        const slot = this._client_slots[i];
        if (slot.permuter == null) chosen = slot;
        else if (chosen != null) break;
      }
      if (chosen == null) { has_more = true; break; }
      const perm = this._permuters.get(key);
      perm.slot = chosen;
      chosen.permuter = key;
      this._update_permuter(perm, chosen);
      this._update_item(chosen.menu_id, `${perm.fn_name} (${perm.nickname})`, { enabled: true });
    }
    this._update_item(this._more_id, "More...", { hidden: !has_more });
  }

  _hide_slot(slot) {
    if (slot.permuter != null) this._update_item(slot.menu_id, "", { hidden: true });
    slot.permuter = null;
  }

  server_reconnecting() { this._status = "connecting"; this._update_status(); }

  server_connected() { this._status = "connected"; this._update_status(); }

  server_failed(graceful, message = null) {
    this._status = graceful ? "reconnecting" : "failed";
    this._fail_message = message;
    this._permuters = new Map();
    this._update_status();
    for (const slot of this._client_slots) this._hide_slot(slot);
    this._fill_slots();
  }

  connect(handle, nickname, fn_name) {
    this._permuters.set(handle, { nickname, fn_name, iterations: 0, improvements: 0, last_systray_update: 0, slot: null });
    this._fill_slots();
    this._update_status();
  }

  disconnect(handle) {
    const slot = this._permuters.get(handle)?.slot;
    this._permuters.delete(handle);
    this._update_status();
    if (slot) this._hide_slot(slot);
    this._fill_slots();
  }

  work_done(handle, is_improvement) {
    const perm = this._permuters.get(handle);
    if (!perm) return;
    perm.iterations += 1;
    if (is_improvement) perm.improvements += 1;
    const now = Date.now() / 1000;
    if (perm.slot && now > perm.last_systray_update + UPDATE_INTERVAL) {
      perm.last_systray_update = now;
      this._update_permuter(perm, perm.slot);
    }
  }

  async stop() {
    this._send({ type: "exit" });
    try { this._proc.stdin.end(); } catch { /* gone */ }
    await this._exited;
  }
}
