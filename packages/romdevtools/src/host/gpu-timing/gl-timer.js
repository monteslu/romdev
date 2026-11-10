// GPU time of a GL frame from a GL_TIME_ELAPSED query
// (EXT_disjoint_timer_query_webgl2) around the frame, on the frame's own
// context. Works on any WebGL2-shaped context object (webgl-node's).
//
// What it measures: GPU time from the frame's first command to its last, so it
// includes any time the GPU sat idle inside the frame waiting for the CPU to
// submit more (a "span"). WebGPU's timer reports busy time per pass besides.
//
// GL cannot nest two TIME_ELAPSED queries. If the cart begins its own while
// the host's is open, the host's query is ended at that point and restarted
// after the cart's ends; the cart's own interval is then not in the host's
// number, and the frame is marked `incomplete` (cartwheel carts never time GL
// passes in a cart, so this is for other carts).
//
// Plain JS ESM + JSDoc.

const TIME_ELAPSED = 0x88bf;
const GPU_DISJOINT = 0x8fbb;

export class GlFrameTimer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    let ext = null;
    try { ext = gl?.getExtension?.("EXT_disjoint_timer_query_webgl2"); } catch { ext = null; }
    this.available = !!ext && typeof gl.beginQuery === "function";
    this.reason = this.available ? null
      : "this GL context has no EXT_disjoint_timer_query_webgl2 (no GL timer queries)";
    this._open = null;
    this._segments = [];
    this._incomplete = false;
    this._pool = [];
    this._wrapped = false;
  }

  /** Wrap the context's beginQuery/endQuery so a cart's own TIME_ELAPSED query
   *  does not collide with the host's. Call before the cart's first frame. */
  wrap() {
    if (this._wrapped || !this.available) return;
    this._wrapped = true;
    const gl = this.gl, timer = this;
    const begin = gl.beginQuery.bind(gl), end = gl.endQuery.bind(gl);
    this._begin = begin; this._end = end;
    gl.beginQuery = function (target, q) {
      if (target === TIME_ELAPSED && timer._open) { end(TIME_ELAPSED); timer._segments.push(timer._open); timer._open = null; timer._paused = true; timer._incomplete = true; }
      return begin(target, q);
    };
    gl.endQuery = function (target) {
      const r = end(target);
      if (target === TIME_ELAPSED && timer._paused) { timer._paused = false; timer._startSegment(); }
      return r;
    };
  }

  _query() { return this._pool.pop() || this.gl.createQuery(); }

  _startSegment() {
    const q = this._query();
    (this._begin || this.gl.beginQuery.bind(this.gl))(TIME_ELAPSED, q);
    this._open = q;
  }

  beginFrame() {
    if (!this.available) return;
    this._segments = [];
    this._incomplete = false;
    this._paused = false;
    // clear the disjoint flag before the frame
    try { this.gl.getParameter(GPU_DISJOINT); } catch { /* ignore */ }
    this._startSegment();
  }

  /** End the frame's query. Call gl.finish() (or wait) before readFrame(). */
  endFrame() {
    if (!this.available) return;
    if (this._open) { (this._end || this.gl.endQuery.bind(this.gl))(TIME_ELAPSED); this._segments.push(this._open); this._open = null; }
  }

  /** The frame's GPU ms, or null when a result is missing or the GPU timer
   *  was disjoint (a clock change or reset makes the result meaningless). */
  readFrame() {
    if (!this.available) return null;
    const gl = this.gl;
    let ns = 0, ok = true;
    for (const q of this._segments) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { ok = false; }
      else ns += Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
      this._pool.push(q);
    }
    this._segments = [];
    let disjoint = false;
    try { disjoint = !!gl.getParameter(GPU_DISJOINT); } catch { /* ignore */ }
    if (!ok || disjoint) return { gpuMs: null, disjoint, incomplete: this._incomplete };
    return { gpuMs: ns / 1e6, disjoint: false, incomplete: this._incomplete };
  }
}
