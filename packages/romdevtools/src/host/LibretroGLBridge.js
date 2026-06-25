// LibretroGLBridge.js — Maps Emscripten GL imports to native-gles
//
// Emscripten-compiled libretro cores import GL functions as env.glClear,
// env.glBindFramebuffer, etc. (plus env.emscripten_glXxx for get_proc_address).
// These normally use GLctx (a WebGL context) which doesn't exist in Node.js.
//
// This module provides native-gles implementations that can be patched into
// the Emscripten env imports, using the same WASM memory marshaling patterns
// as wasmcart's gl_imports.js.

/* eslint-disable no-unused-vars -- GL bridge stubs mirror the libretro/Emscripten
   GL ABI signatures verbatim; some params are unused but kept so each function
   documents its real ABI (and so the port stays diff-able against upstream). */

// `native-gles` is injected by the caller (createEmscriptenGLBridge(getMemory, gl))
// rather than imported here — it's an OPTIONAL dependency loaded lazily by the host
// only when a HW-render core boots (see glOptionalDep.js / LibretroHost).
let gl = null;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readCString(u8, ptr) {
  let end = ptr;
  while (u8[end] !== 0) end++;
  return decoder.decode(u8.subarray(ptr, end));
}

// GL format/type → bytes per pixel
function _bytesPerPixel(format, type) {
  const GL_ALPHA = 0x1906, GL_LUMINANCE = 0x1909, GL_RED = 0x1903, GL_DEPTH_COMPONENT = 0x1902;
  const GL_LUMINANCE_ALPHA = 0x190A, GL_RG = 0x8227;
  const GL_RGB = 0x1907, GL_RGBA = 0x1908;

  let channels;
  switch (format) {
    case GL_ALPHA: case GL_LUMINANCE: case GL_RED: case GL_DEPTH_COMPONENT: channels = 1; break;
    case GL_LUMINANCE_ALPHA: case GL_RG: channels = 2; break;
    case GL_RGB: channels = 3; break;
    case GL_RGBA: default: channels = 4; break;
  }

  switch (type) {
    case 0x1401: return channels;           // GL_UNSIGNED_BYTE
    case 0x8363: case 0x8033: case 0x8034: return 2; // packed 16-bit
    case 0x140B: case 0x1403: return channels * 2; // HALF_FLOAT, UNSIGNED_SHORT
    case 0x1406: case 0x1405: return channels * 4; // FLOAT, UNSIGNED_INT
    default: return channels;
  }
}

/**
 * Create GL function implementations for patching into Emscripten's env imports.
 *
 * @param {function} getMemory - returns the WASM Memory object
 * @param {object} nativeGl - the loaded `native-gles` module (from glOptionalDep)
 * @returns {object} map of function name → implementation
 */
export function createEmscriptenGLBridge(getMemory, nativeGl) {
  gl = nativeGl;
  function u8()  { return new Uint8Array(getMemory().buffer); }
  function u32() { return new Uint32Array(getMemory().buffer); }
  function i32() { return new Int32Array(getMemory().buffer); }
  function f32() { return new Float32Array(getMemory().buffer); }

  // String pool for glGetString results (allocated at top of WASM memory)
  let _glStringCache = {};
  let _glStringPool = null;

  function _allocStringInPool(str) {
    if (!_glStringPool) {
      const mem = getMemory();
      _glStringPool = { base: mem.buffer.byteLength - 16384, offset: 0 };
    }
    const encoded = encoder.encode(str);
    const ptr = _glStringPool.base + _glStringPool.offset;
    const mem = u8();
    if (ptr + encoded.length + 1 < mem.length) {
      mem.set(encoded, ptr);
      mem[ptr + encoded.length] = 0;
      _glStringPool.offset += encoded.length + 1;
      _glStringPool.offset = (_glStringPool.offset + 3) & ~3;
      return ptr;
    }
    return 0;
  }

  // Gen/Delete helper
  function genObjects(n, ptr, genFn) {
    const arr = new Uint32Array(n);
    genFn(n, arr);
    const view = u32();
    for (let i = 0; i < n; i++) view[(ptr >> 2) + i] = arr[i];
  }
  function deleteObjects(n, ptr, delFn) {
    const view = u32();
    const arr = new Uint32Array(n);
    for (let i = 0; i < n; i++) arr[i] = view[(ptr >> 2) + i];
    delFn(n, arr);
  }

  // Write info log to WASM memory
  function writeInfoLog(log, bufSize, lengthPtr, infoLogPtr) {
    const mem = u8();
    const encoded = encoder.encode(log || '');
    const copyLen = Math.min(encoded.length, bufSize - 1);
    mem.set(encoded.subarray(0, copyLen), infoLogPtr);
    mem[infoLogPtr + copyLen] = 0;
    if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
  }

  const funcs = {
    // ─── State ────────────────────────────────────────────────────────
    glEnable: (cap) => gl.glEnable(cap),
    glDisable: (cap) => gl.glDisable(cap),
    glGetError: () => gl.glGetError(),
    glFinish: () => gl.glFinish(),
    glFlush: () => gl.glFlush(),
    glHint: (target, mode) => gl.glHint(target, mode),
    glPixelStorei: (pname, param) => gl.glPixelStorei(pname, param),
    glIsEnabled: (cap) => gl.glIsEnabled(cap),

    glGetIntegerv: (pname, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, 4);
      gl.glGetIntegerv(pname, view);
    },
    glGetFloatv: (pname, dataPtr) => {
      const view = new Float32Array(getMemory().buffer, dataPtr, 16);
      gl.glGetFloatv(pname, view);
    },
    glGetBooleanv: (pname, dataPtr) => {
      const val = gl.glGetBooleanv(pname);
      u8()[dataPtr] = val ? 1 : 0;
    },
    glGetString: (name) => {
      if (_glStringCache[name] !== undefined) return _glStringCache[name];
      const str = gl.glGetString(name);
      if (!str) { _glStringCache[name] = 0; return 0; }
      const ptr = _allocStringInPool(str);
      _glStringCache[name] = ptr;
      return ptr;
    },
    glGetStringi: (name, index) => {
      const key = `${name}_${index}`;
      if (_glStringCache[key] !== undefined) return _glStringCache[key];
      const str = gl.glGetStringi(name, index);
      if (!str) { _glStringCache[key] = 0; return 0; }
      const ptr = _allocStringInPool(str);
      _glStringCache[key] = ptr;
      return ptr;
    },

    // ─── Viewport / Clear ────────────────────────────────────────────
    glViewport: (x, y, w, h) => gl.glViewport(x, y, w, h),
    glScissor: (x, y, w, h) => gl.glScissor(x, y, w, h),
    glClear: (mask) => gl.glClear(mask),
    glClearColor: (r, g, b, a) => gl.glClearColor(r, g, b, a),
    glClearDepthf: (d) => gl.glClearDepthf(d),
    glClearStencil: (s) => gl.glClearStencil(s),

    // ─── Blending ────────────────────────────────────────────────────
    glBlendFunc: (sfactor, dfactor) => gl.glBlendFunc(sfactor, dfactor),
    glBlendFuncSeparate: (srcRGB, dstRGB, srcA, dstA) => gl.glBlendFuncSeparate(srcRGB, dstRGB, srcA, dstA),
    glBlendEquation: (mode) => gl.glBlendEquation(mode),
    glBlendEquationSeparate: (modeRGB, modeA) => gl.glBlendEquationSeparate(modeRGB, modeA),
    glBlendColor: (r, g, b, a) => gl.glBlendColor(r, g, b, a),
    glColorMask: (r, g, b, a) => gl.glColorMask(!!r, !!g, !!b, !!a),

    // ─── Depth / Stencil ─────────────────────────────────────────────
    glDepthFunc: (func) => gl.glDepthFunc(func),
    glDepthMask: (flag) => gl.glDepthMask(!!flag),
    glDepthRangef: (n, f) => gl.glDepthRangef(n, f),
    glStencilFunc: (func, ref, mask) => gl.glStencilFunc(func, ref, mask),
    glStencilFuncSeparate: (face, func, ref, mask) => gl.glStencilFuncSeparate(face, func, ref, mask),
    glStencilOp: (fail, zfail, zpass) => gl.glStencilOp(fail, zfail, zpass),
    glStencilOpSeparate: (face, sfail, dpfail, dppass) => gl.glStencilOpSeparate(face, sfail, dpfail, dppass),
    glStencilMask: (mask) => gl.glStencilMask(mask),
    glStencilMaskSeparate: (face, mask) => gl.glStencilMaskSeparate(face, mask),

    // ─── Face culling ────────────────────────────────────────────────
    glCullFace: (mode) => gl.glCullFace(mode),
    glFrontFace: (mode) => gl.glFrontFace(mode),
    glPolygonOffset: (factor, units) => gl.glPolygonOffset(factor, units),
    glLineWidth: (width) => gl.glLineWidth(width),
    glSampleCoverage: (value, invert) => gl.glSampleCoverage(value, !!invert),

    // ─── Buffers ─────────────────────────────────────────────────────
    glGenBuffers: (n, ptr) => genObjects(n, ptr, gl.glGenBuffers.bind(gl)),
    glDeleteBuffers: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteBuffers.bind(gl)),
    glBindBuffer: (target, buffer) => gl.glBindBuffer(target, buffer),
    glBufferData: (target, size, dataPtr, usage) => {
      if (dataPtr) {
        gl.glBufferData(target, u8().subarray(dataPtr, dataPtr + size), usage);
      } else {
        // Allocate without data — pass a zeroed buffer
        gl.glBufferData(target, new Uint8Array(size), usage);
      }
    },
    glBufferSubData: (target, offset, size, dataPtr) => {
      gl.glBufferSubData(target, offset, u8().subarray(dataPtr, dataPtr + size));
    },
    glCopyBufferSubData: (readTarget, writeTarget, readOffset, writeOffset, size) => {
      gl.glCopyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size);
    },
    glIsBuffer: (buffer) => gl.glIsBuffer(buffer),

    // ─── Textures ────────────────────────────────────────────────────
    glGenTextures: (n, ptr) => genObjects(n, ptr, gl.glGenTextures.bind(gl)),
    glDeleteTextures: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteTextures.bind(gl)),
    glBindTexture: (target, texture) => gl.glBindTexture(target, texture),
    glActiveTexture: (texture) => gl.glActiveTexture(texture),
    glTexImage2D: (target, level, internalformat, width, height, border, format, type, pixelsPtr) => {
      if (pixelsPtr === 0) {
        gl.glTexImage2D(target, level, internalformat, width, height, border, format, type, null);
      } else {
        const bpp = _bytesPerPixel(format, type);
        const size = width * height * bpp;
        gl.glTexImage2D(target, level, internalformat, width, height, border, format, type,
          u8().subarray(pixelsPtr, pixelsPtr + size));
      }
    },
    glTexSubImage2D: (target, level, xoffset, yoffset, width, height, format, type, pixelsPtr) => {
      const bpp = _bytesPerPixel(format, type);
      const size = width * height * bpp;
      gl.glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type,
        u8().subarray(pixelsPtr, pixelsPtr + size));
    },
    glTexParameteri: (target, pname, param) => gl.glTexParameteri(target, pname, param),
    glTexParameterf: (target, pname, param) => gl.glTexParameterf(target, pname, param),
    glTexParameteriv: (target, pname, paramsPtr) => {
      gl.glTexParameteriv(target, pname, new Int32Array(getMemory().buffer, paramsPtr, 4));
    },
    glGenerateMipmap: (target) => gl.glGenerateMipmap(target),
    glCompressedTexImage2D: (target, level, internalformat, width, height, border, imageSize, dataPtr) => {
      gl.glCompressedTexImage2D(target, level, internalformat, width, height, border,
        u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glCompressedTexSubImage2D: (target, level, xoffset, yoffset, width, height, format, imageSize, dataPtr) => {
      gl.glCompressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format,
        u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glTexImage3D: (target, level, internalformat, width, height, depth, border, format, type, pixelsPtr) => {
      if (pixelsPtr === 0) {
        gl.glTexImage3D(target, level, internalformat, width, height, depth, border, format, type, null);
      } else {
        const bpp = _bytesPerPixel(format, type);
        const size = width * height * depth * bpp;
        gl.glTexImage3D(target, level, internalformat, width, height, depth, border, format, type,
          u8().subarray(pixelsPtr, pixelsPtr + size));
      }
    },
    glTexSubImage3D: (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixelsPtr) => {
      const bpp = _bytesPerPixel(format, type);
      const size = width * height * depth * bpp;
      gl.glTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type,
        u8().subarray(pixelsPtr, pixelsPtr + size));
    },
    glTexStorage2D: (target, levels, internalformat, width, height) => {
      gl.glTexStorage2D(target, levels, internalformat, width, height);
    },
    glTexStorage3D: (target, levels, internalformat, width, height, depth) => {
      gl.glTexStorage3D(target, levels, internalformat, width, height, depth);
    },
    glCopyTexImage2D: (target, level, internalformat, x, y, width, height, border) => {
      gl.glCopyTexImage2D(target, level, internalformat, x, y, width, height, border);
    },
    glCopyTexSubImage2D: (target, level, xoffset, yoffset, x, y, width, height) => {
      gl.glCopyTexSubImage2D(target, level, xoffset, yoffset, x, y, width, height);
    },
    glCopyTexSubImage3D: (target, level, xoffset, yoffset, zoffset, x, y, width, height) => {
      gl.glCopyTexSubImage3D(target, level, xoffset, yoffset, zoffset, x, y, width, height);
    },
    glCompressedTexImage3D: (target, level, internalformat, width, height, depth, border, imageSize, dataPtr) => {
      gl.glCompressedTexImage3D(target, level, internalformat, width, height, depth, border,
        u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glCompressedTexSubImage3D: (target, level, xoffset, yoffset, zoffset, width, height, depth, format, imageSize, dataPtr) => {
      gl.glCompressedTexSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format,
        u8().subarray(dataPtr, dataPtr + imageSize));
    },
    glIsTexture: (texture) => gl.glIsTexture(texture),
    glGetTexParameteriv: (target, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetTexParameteriv(target, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetTexParameterfv: (target, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetTexParameterfv(target, pname, buf);
      const view = new DataView(getMemory().buffer);
      view.setFloat32(paramsPtr, buf.readFloatLE(0), true);
    },

    // ─── Shaders ─────────────────────────────────────────────────────
    glCreateShader: (type) => gl.glCreateShader(type),
    glDeleteShader: (shader) => gl.glDeleteShader(shader),
    glIsShader: (shader) => gl.glIsShader(shader),
    glShaderSource: (shader, count, stringsPtr, lengthsPtr) => {
      const mem = u8();
      const ptrs = u32();
      const lens = lengthsPtr ? i32() : null;
      let fullSource = '';
      for (let i = 0; i < count; i++) {
        const strPtr = ptrs[(stringsPtr >> 2) + i];
        if (lens && lens[(lengthsPtr >> 2) + i] > 0) {
          const len = lens[(lengthsPtr >> 2) + i];
          fullSource += decoder.decode(mem.subarray(strPtr, strPtr + len));
        } else {
          fullSource += readCString(mem, strPtr);
        }
      }
      gl.glShaderSource(shader, fullSource);
    },
    glCompileShader: (shader) => gl.glCompileShader(shader),
    glGetShaderiv: (shader, pname, paramsPtr) => {
      const result = gl.glGetShaderiv(shader, pname);
      if (paramsPtr) i32()[paramsPtr >> 2] = result;
      return result;
    },
    glGetShaderInfoLog: (shader, bufSize, lengthPtr, infoLogPtr) => {
      writeInfoLog(gl.glGetShaderInfoLog(shader), bufSize, lengthPtr, infoLogPtr);
    },
    glGetShaderSource: (shader, bufSize, lengthPtr, sourcePtr) => {
      writeInfoLog(gl.glGetShaderSource(shader), bufSize, lengthPtr, sourcePtr);
    },
    glShaderBinary: (count, shadersPtr, binaryFormat, binaryPtr, length) => {
      // Usually not supported on GLES — no-op
    },
    glReleaseShaderCompiler: () => {},
    glGetShaderPrecisionFormat: (shadertype, precisiontype, rangePtr, precisionPtr) => {
      // Return reasonable defaults for GLES2/3
      const view = i32();
      if (rangePtr) { view[rangePtr >> 2] = 127; view[(rangePtr >> 2) + 1] = 127; }
      if (precisionPtr) view[precisionPtr >> 2] = 23;
    },

    // ─── Programs ────────────────────────────────────────────────────
    glCreateProgram: () => gl.glCreateProgram(),
    glDeleteProgram: (program) => gl.glDeleteProgram(program),
    glIsProgram: (program) => gl.glIsProgram(program),
    glAttachShader: (program, shader) => gl.glAttachShader(program, shader),
    glDetachShader: (program, shader) => gl.glDetachShader(program, shader),
    glLinkProgram: (program) => gl.glLinkProgram(program),
    glUseProgram: (program) => gl.glUseProgram(program),
    glValidateProgram: (program) => gl.glValidateProgram(program),
    glGetProgramiv: (program, pname, paramsPtr) => {
      const result = gl.glGetProgramiv(program, pname);
      if (paramsPtr) i32()[paramsPtr >> 2] = result;
      return result;
    },
    glGetProgramInfoLog: (program, bufSize, lengthPtr, infoLogPtr) => {
      writeInfoLog(gl.glGetProgramInfoLog(program), bufSize, lengthPtr, infoLogPtr);
    },
    glBindAttribLocation: (program, index, namePtr) => {
      gl.glBindAttribLocation(program, index, readCString(u8(), namePtr));
    },
    glGetAttribLocation: (program, namePtr) => {
      return gl.glGetAttribLocation(program, readCString(u8(), namePtr));
    },
    glGetUniformLocation: (program, namePtr) => {
      return gl.glGetUniformLocation(program, readCString(u8(), namePtr));
    },
    glGetActiveAttrib: (program, index, bufSize, lengthPtr, sizePtr, typePtr, namePtr) => {
      const result = gl.glGetActiveAttrib(program, index, bufSize);
      const mem = u8();
      if (result && result.name) {
        const encoded = encoder.encode(result.name);
        const copyLen = Math.min(encoded.length, bufSize - 1);
        mem.set(encoded.subarray(0, copyLen), namePtr);
        mem[namePtr + copyLen] = 0;
        if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
        if (sizePtr) i32()[sizePtr >> 2] = result.size;
        if (typePtr) u32()[typePtr >> 2] = result.type;
      } else {
        if (lengthPtr) u32()[lengthPtr >> 2] = 0;
        if (namePtr) mem[namePtr] = 0;
      }
    },
    glGetActiveUniform: (program, index, bufSize, lengthPtr, sizePtr, typePtr, namePtr) => {
      const result = gl.glGetActiveUniform(program, index, bufSize);
      const mem = u8();
      if (result && result.name) {
        const encoded = encoder.encode(result.name);
        const copyLen = Math.min(encoded.length, bufSize - 1);
        mem.set(encoded.subarray(0, copyLen), namePtr);
        mem[namePtr + copyLen] = 0;
        if (lengthPtr) u32()[lengthPtr >> 2] = copyLen;
        if (sizePtr) i32()[sizePtr >> 2] = result.size;
        if (typePtr) u32()[typePtr >> 2] = result.type;
      } else {
        if (lengthPtr) u32()[lengthPtr >> 2] = 0;
        if (namePtr) mem[namePtr] = 0;
      }
    },
    glGetAttachedShaders: (program, maxCount, countPtr, shadersPtr) => {
      // Rarely used — stub with empty result
      if (countPtr) i32()[countPtr >> 2] = 0;
    },
    glGetProgramBinary: (program, bufSize, lengthPtr, binaryFormatPtr, binaryPtr) => {
      // Not critical — stub
      if (lengthPtr) i32()[lengthPtr >> 2] = 0;
    },
    glProgramBinary: (program, binaryFormat, binaryPtr, length) => {
      const data = u8().subarray(binaryPtr, binaryPtr + length);
      gl.glProgramBinary(program, binaryFormat, data, length);
    },
    glProgramParameteri: (program, pname, value) => {
      // GL_PROGRAM_BINARY_RETRIEVABLE_HINT — no-op is fine
    },

    // ─── Uniforms ────────────────────────────────────────────────────
    glUniform1i: (loc, v0) => gl.glUniform1i(loc, v0),
    glUniform2i: (loc, v0, v1) => gl.glUniform2i(loc, v0, v1),
    glUniform3i: (loc, v0, v1, v2) => gl.glUniform3i(loc, v0, v1, v2),
    glUniform4i: (loc, v0, v1, v2, v3) => gl.glUniform4i(loc, v0, v1, v2, v3),
    glUniform1f: (loc, v0) => gl.glUniform1f(loc, v0),
    glUniform2f: (loc, v0, v1) => gl.glUniform2f(loc, v0, v1),
    glUniform3f: (loc, v0, v1, v2) => gl.glUniform3f(loc, v0, v1, v2),
    glUniform4f: (loc, v0, v1, v2, v3) => gl.glUniform4f(loc, v0, v1, v2, v3),
    glUniform1ui: (loc, v0) => gl.glUniform1ui(loc, v0),
    glUniform1iv: (loc, count, ptr) => gl.glUniform1iv(loc, new Int32Array(getMemory().buffer, ptr, count)),
    glUniform2iv: (loc, count, ptr) => gl.glUniform2iv(loc, new Int32Array(getMemory().buffer, ptr, count * 2)),
    glUniform3iv: (loc, count, ptr) => gl.glUniform3iv(loc, new Int32Array(getMemory().buffer, ptr, count * 3)),
    glUniform4iv: (loc, count, ptr) => gl.glUniform4iv(loc, new Int32Array(getMemory().buffer, ptr, count * 4)),
    glUniform1fv: (loc, count, ptr) => gl.glUniform1fv(loc, new Float32Array(getMemory().buffer, ptr, count)),
    glUniform2fv: (loc, count, ptr) => gl.glUniform2fv(loc, new Float32Array(getMemory().buffer, ptr, count * 2)),
    glUniform3fv: (loc, count, ptr) => gl.glUniform3fv(loc, new Float32Array(getMemory().buffer, ptr, count * 3)),
    glUniform4fv: (loc, count, ptr) => gl.glUniform4fv(loc, new Float32Array(getMemory().buffer, ptr, count * 4)),
    glUniform1uiv: (loc, count, ptr) => gl.glUniform1uiv(loc, new Uint32Array(getMemory().buffer, ptr, count)),
    glUniform2uiv: (loc, count, ptr) => gl.glUniform2uiv(loc, new Uint32Array(getMemory().buffer, ptr, count * 2)),
    glUniform3uiv: (loc, count, ptr) => gl.glUniform3uiv(loc, new Uint32Array(getMemory().buffer, ptr, count * 3)),
    glUniform4uiv: (loc, count, ptr) => gl.glUniform4uiv(loc, new Uint32Array(getMemory().buffer, ptr, count * 4)),
    glUniformMatrix2fv: (loc, count, transpose, ptr) => gl.glUniformMatrix2fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 4)),
    glUniformMatrix3fv: (loc, count, transpose, ptr) => gl.glUniformMatrix3fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 9)),
    glUniformMatrix4fv: (loc, count, transpose, ptr) => gl.glUniformMatrix4fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 16)),
    glUniformMatrix2x3fv: (loc, count, transpose, ptr) => gl.glUniformMatrix2x3fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 6)),
    glUniformMatrix3x2fv: (loc, count, transpose, ptr) => gl.glUniformMatrix3x2fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 6)),
    glUniformMatrix2x4fv: (loc, count, transpose, ptr) => gl.glUniformMatrix2x4fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 8)),
    glUniformMatrix4x2fv: (loc, count, transpose, ptr) => gl.glUniformMatrix4x2fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 8)),
    glUniformMatrix3x4fv: (loc, count, transpose, ptr) => gl.glUniformMatrix3x4fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 12)),
    glUniformMatrix4x3fv: (loc, count, transpose, ptr) => gl.glUniformMatrix4x3fv(loc, !!transpose, new Float32Array(getMemory().buffer, ptr, count * 12)),

    // UBO
    glGetUniformBlockIndex: (program, namePtr) => gl.glGetUniformBlockIndex(program, readCString(u8(), namePtr)),
    glUniformBlockBinding: (program, index, binding) => gl.glUniformBlockBinding(program, index, binding),
    glGetActiveUniformBlockiv: (program, index, pname, paramsPtr) => {
      const view = new Int32Array(getMemory().buffer, paramsPtr, 4);
      gl.glGetActiveUniformBlockiv(program, index, pname, view);
    },
    glGetActiveUniformBlockName: (program, index, bufSize, lengthPtr, namePtr) => {
      const result = gl.glGetActiveUniformBlockName(program, index, bufSize);
      writeInfoLog(result, bufSize, lengthPtr, namePtr);
    },
    glGetActiveUniformsiv: (program, uniformCount, uniformIndicesPtr, pname, paramsPtr) => {
      // Stub — rarely used
      for (let i = 0; i < uniformCount; i++) i32()[(paramsPtr >> 2) + i] = 0;
    },
    glGetUniformIndices: (program, uniformCount, uniformNamesPtr, uniformIndicesPtr) => {
      // Stub
      for (let i = 0; i < uniformCount; i++) u32()[(uniformIndicesPtr >> 2) + i] = 0xFFFFFFFF;
    },
    glGetFragDataLocation: (program, namePtr) => {
      return gl.glGetFragDataLocation(program, readCString(u8(), namePtr));
    },

    // ─── Vertex attribs ──────────────────────────────────────────────
    glEnableVertexAttribArray: (index) => gl.glEnableVertexAttribArray(index),
    glDisableVertexAttribArray: (index) => gl.glDisableVertexAttribArray(index),
    glVertexAttribPointer: (index, size, type, normalized, stride, offset) => {
      gl.glVertexAttribPointer(index, size, type, !!normalized, stride, offset);
    },
    glVertexAttribIPointer: (index, size, type, stride, offset) => {
      gl.glVertexAttribIPointer(index, size, type, stride, offset);
    },
    glVertexAttribDivisor: (index, divisor) => gl.glVertexAttribDivisor(index, divisor),
    glVertexAttrib1f: (index, x) => gl.glVertexAttrib1f(index, x),
    glVertexAttrib1fv: (index, vPtr) => gl.glVertexAttrib1fv(index, new Float32Array(getMemory().buffer, vPtr, 1)),
    glVertexAttrib2f: (index, x, y) => gl.glVertexAttrib2f(index, x, y),
    glVertexAttrib2fv: (index, vPtr) => gl.glVertexAttrib2fv(index, new Float32Array(getMemory().buffer, vPtr, 2)),
    glVertexAttrib3f: (index, x, y, z) => gl.glVertexAttrib3f(index, x, y, z),
    glVertexAttrib3fv: (index, vPtr) => gl.glVertexAttrib3fv(index, new Float32Array(getMemory().buffer, vPtr, 3)),
    glVertexAttrib4f: (index, x, y, z, w) => gl.glVertexAttrib4f(index, x, y, z, w),
    glVertexAttrib4fv: (index, vPtr) => gl.glVertexAttrib4fv(index, new Float32Array(getMemory().buffer, vPtr, 4)),
    glVertexAttribI4i: (index, x, y, z, w) => gl.glVertexAttribI4i(index, x, y, z, w),
    glVertexAttribI4ui: (index, x, y, z, w) => gl.glVertexAttribI4ui(index, x, y, z, w),
    glVertexAttribI4iv: (index, vPtr) => gl.glVertexAttribI4iv(index, new Int32Array(getMemory().buffer, vPtr, 4)),
    glVertexAttribI4uiv: (index, vPtr) => gl.glVertexAttribI4uiv(index, new Uint32Array(getMemory().buffer, vPtr, 4)),
    glGetVertexAttribiv: (index, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetVertexAttribiv(index, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetVertexAttribfv: (index, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetVertexAttribfv(index, pname, buf);
      new DataView(getMemory().buffer).setFloat32(paramsPtr, buf.readFloatLE(0), true);
    },
    glGetVertexAttribPointerv: (index, pname, pointerPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetVertexAttribPointerv(index, pname, buf);
      u32()[pointerPtr >> 2] = buf.readUInt32LE(0);
    },
    glGetVertexAttribIiv: (index, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetVertexAttribIiv(index, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetVertexAttribIuiv: (index, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetVertexAttribIuiv(index, pname, buf);
      u32()[paramsPtr >> 2] = buf.readUInt32LE(0);
    },

    // ─── Drawing ─────────────────────────────────────────────────────
    glDrawArrays: (mode, first, count) => gl.glDrawArrays(mode, first, count),
    glDrawElements: (mode, count, type, offset) => gl.glDrawElements(mode, count, type, offset),
    glDrawArraysInstanced: (mode, first, count, instancecount) => gl.glDrawArraysInstanced(mode, first, count, instancecount),
    glDrawElementsInstanced: (mode, count, type, offset, instancecount) => gl.glDrawElementsInstanced(mode, count, type, offset, instancecount),
    glDrawRangeElements: (mode, start, end, count, type, offset) => gl.glDrawRangeElements(mode, start, end, count, type, offset),
    glDrawBuffers: (n, bufsPtr) => {
      const arr = new Uint32Array(n);
      const view = u32();
      for (let i = 0; i < n; i++) arr[i] = view[(bufsPtr >> 2) + i];
      gl.glDrawBuffers(arr);
    },

    // ─── FBOs ────────────────────────────────────────────────────────
    glGenFramebuffers: (n, ptr) => genObjects(n, ptr, gl.glGenFramebuffers.bind(gl)),
    glDeleteFramebuffers: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteFramebuffers.bind(gl)),
    glBindFramebuffer: (target, framebuffer) => gl.glBindFramebuffer(target, framebuffer),
    glCheckFramebufferStatus: (target) => gl.glCheckFramebufferStatus(target),
    glFramebufferTexture2D: (target, attachment, textarget, texture, level) => {
      gl.glFramebufferTexture2D(target, attachment, textarget, texture, level);
    },
    glFramebufferRenderbuffer: (target, attachment, renderbuffertarget, renderbuffer) => {
      gl.glFramebufferRenderbuffer(target, attachment, renderbuffertarget, renderbuffer);
    },
    glFramebufferTextureLayer: (target, attachment, texture, level, layer) => {
      gl.glFramebufferTextureLayer(target, attachment, texture, level, layer);
    },
    glBlitFramebuffer: (srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter) => {
      gl.glBlitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
    },
    glInvalidateFramebuffer: (target, numAttachments, attachmentsPtr) => {
      const arr = new Uint32Array(numAttachments);
      const view = u32();
      for (let i = 0; i < numAttachments; i++) arr[i] = view[(attachmentsPtr >> 2) + i];
      gl.glInvalidateFramebuffer(target, arr);
    },
    glInvalidateSubFramebuffer: (target, numAttachments, attachmentsPtr, x, y, width, height) => {
      // Stub — optimization hint only
    },
    glIsFramebuffer: (framebuffer) => gl.glIsFramebuffer(framebuffer),
    glGetFramebufferAttachmentParameteriv: (target, attachment, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetFramebufferAttachmentParameteriv(target, attachment, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glReadBuffer: (mode) => gl.glReadBuffer(mode),

    // ─── RBOs ────────────────────────────────────────────────────────
    glGenRenderbuffers: (n, ptr) => genObjects(n, ptr, gl.glGenRenderbuffers.bind(gl)),
    glDeleteRenderbuffers: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteRenderbuffers.bind(gl)),
    glBindRenderbuffer: (target, renderbuffer) => gl.glBindRenderbuffer(target, renderbuffer),
    glRenderbufferStorage: (target, internalformat, width, height) => {
      gl.glRenderbufferStorage(target, internalformat, width, height);
    },
    glRenderbufferStorageMultisample: (target, samples, internalformat, width, height) => {
      gl.glRenderbufferStorageMultisample(target, samples, internalformat, width, height);
    },
    glIsRenderbuffer: (renderbuffer) => gl.glIsRenderbuffer(renderbuffer),
    glGetRenderbufferParameteriv: (target, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetRenderbufferParameteriv(target, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetInternalformativ: (target, internalformat, pname, bufSize, paramsPtr) => {
      // Return reasonable defaults
      i32()[paramsPtr >> 2] = 4; // at least 4 samples
    },

    // ─── Readback ────────────────────────────────────────────────────
    glReadPixels: (x, y, width, height, format, type, pixelsPtr) => {
      const bpp = _bytesPerPixel(format, type);
      const size = width * height * bpp;
      const buf = u8().subarray(pixelsPtr, pixelsPtr + size);
      gl.glReadPixels(x, y, width, height, format, type, buf);
    },

    // ─── VAO ─────────────────────────────────────────────────────────
    glGenVertexArrays: (n, ptr) => genObjects(n, ptr, gl.glGenVertexArrays.bind(gl)),
    glDeleteVertexArrays: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteVertexArrays.bind(gl)),
    glBindVertexArray: (array) => gl.glBindVertexArray(array),
    glIsVertexArray: (array) => gl.glIsVertexArray(array),

    // ─── Queries ─────────────────────────────────────────────────────
    glGenQueries: (n, ptr) => genObjects(n, ptr, gl.glGenQueries.bind(gl)),
    glDeleteQueries: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteQueries.bind(gl)),
    glBeginQuery: (target, id) => gl.glBeginQuery(target, id),
    glEndQuery: (target) => gl.glEndQuery(target),
    glIsQuery: (id) => gl.glIsQuery(id),
    glGetQueryiv: (target, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetQueryiv(target, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetQueryObjectuiv: (id, pname, paramsPtr) => {
      const result = gl.glGetQueryObjectuiv(id, pname);
      u32()[paramsPtr >> 2] = result;
    },
    glGetBufferParameteriv: (target, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetBufferParameteriv(target, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetBufferParameteri64v: (target, pname, paramsPtr) => {
      // Return buffer param as i64
      const buf = Buffer.alloc(4);
      gl.glGetBufferParameteriv(target, pname, buf);
      const view = new DataView(getMemory().buffer);
      view.setBigInt64(paramsPtr, BigInt(buf.readInt32LE(0)), true);
    },

    // ─── Samplers ────────────────────────────────────────────────────
    glGenSamplers: (n, ptr) => genObjects(n, ptr, gl.glGenSamplers.bind(gl)),
    glDeleteSamplers: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteSamplers.bind(gl)),
    glBindSampler: (unit, sampler) => gl.glBindSampler(unit, sampler),
    glSamplerParameteri: (sampler, pname, param) => gl.glSamplerParameteri(sampler, pname, param),
    glSamplerParameterf: (sampler, pname, param) => gl.glSamplerParameterf(sampler, pname, param),
    glSamplerParameteriv: (sampler, pname, paramsPtr) => {
      gl.glSamplerParameteriv(sampler, pname, new Int32Array(getMemory().buffer, paramsPtr, 4));
    },
    glSamplerParameterfv: (sampler, pname, paramsPtr) => {
      gl.glSamplerParameterfv(sampler, pname, new Float32Array(getMemory().buffer, paramsPtr, 4));
    },
    glGetSamplerParameteriv: (sampler, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetSamplerParameteriv(sampler, pname, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetSamplerParameterfv: (sampler, pname, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetSamplerParameterfv(sampler, pname, buf);
      new DataView(getMemory().buffer).setFloat32(paramsPtr, buf.readFloatLE(0), true);
    },
    glIsSampler: (sampler) => gl.glIsSampler(sampler),

    // ─── Transform feedback ──────────────────────────────────────────
    glGenTransformFeedbacks: (n, ptr) => genObjects(n, ptr, gl.glGenTransformFeedbacks.bind(gl)),
    glDeleteTransformFeedbacks: (n, ptr) => deleteObjects(n, ptr, gl.glDeleteTransformFeedbacks.bind(gl)),
    glBindTransformFeedback: (target, id) => gl.glBindTransformFeedback(target, id),
    glBeginTransformFeedback: (primitiveMode) => gl.glBeginTransformFeedback(primitiveMode),
    glEndTransformFeedback: () => gl.glEndTransformFeedback(),
    glPauseTransformFeedback: () => gl.glPauseTransformFeedback(),
    glResumeTransformFeedback: () => gl.glResumeTransformFeedback(),
    glIsTransformFeedback: (id) => gl.glIsTransformFeedback(id),
    glTransformFeedbackVaryings: (program, count, varyingsPtr, bufferMode) => {
      const ptrs = new Uint32Array(getMemory().buffer, varyingsPtr, count);
      const names = [];
      const mem = u8();
      for (let i = 0; i < count; i++) names.push(readCString(mem, ptrs[i]));
      gl.glTransformFeedbackVaryings(program, names, bufferMode);
    },
    glGetTransformFeedbackVarying: (program, index, bufSize, lengthPtr, sizePtr, typePtr, namePtr) => {
      // Stub
      if (lengthPtr) u32()[lengthPtr >> 2] = 0;
      if (namePtr) u8()[namePtr] = 0;
    },

    // ─── Sync ────────────────────────────────────────────────────────
    glFenceSync: (condition, flags) => gl.glFenceSync(condition, flags),
    glClientWaitSync: (sync, flags, timeout) => gl.glClientWaitSync(sync, flags, timeout),
    glDeleteSync: (sync) => gl.glDeleteSync(sync),
    glWaitSync: (sync, flags, timeout) => gl.glWaitSync(sync, flags, timeout),
    glIsSync: (sync) => gl.glIsSync(sync),
    glGetSynciv: (sync, pname, bufSize, lengthPtr, valuesPtr) => {
      const buf = Buffer.alloc(bufSize * 4);
      const lenBuf = Buffer.alloc(4);
      gl.glGetSynciv(sync, pname, bufSize, lenBuf, buf);
      if (lengthPtr) i32()[lengthPtr >> 2] = lenBuf.readInt32LE(0);
      const count = Math.min(lenBuf.readInt32LE(0), bufSize);
      const dst = i32();
      for (let i = 0; i < count; i++) dst[(valuesPtr >> 2) + i] = buf.readInt32LE(i * 4);
    },

    // ─── Clear buffers (ES3) ─────────────────────────────────────────
    glClearBufferfv: (buffer, drawbuffer, valuePtr) => {
      const GL_COLOR = 0x1800;
      const numFloats = (buffer === GL_COLOR) ? 4 : 1;
      gl.glClearBufferfv(buffer, drawbuffer, new Float32Array(getMemory().buffer, valuePtr, numFloats));
    },
    glClearBufferiv: (buffer, drawbuffer, valuePtr) => {
      gl.glClearBufferiv(buffer, drawbuffer, new Int32Array(getMemory().buffer, valuePtr, 4));
    },
    glClearBufferuiv: (buffer, drawbuffer, valuePtr) => {
      gl.glClearBufferuiv(buffer, drawbuffer, new Uint32Array(getMemory().buffer, valuePtr, 4));
    },
    glClearBufferfi: (buffer, drawbuffer, depth, stencil) => {
      gl.glClearBufferfi(buffer, drawbuffer, depth, stencil);
    },

    // ─── Buffer binding ──────────────────────────────────────────────
    glBindBufferBase: (target, index, buffer) => gl.glBindBufferBase(target, index, buffer),
    glBindBufferRange: (target, index, buffer, offset, size) => gl.glBindBufferRange(target, index, buffer, offset, size),

    // ─── Integer state queries ───────────────────────────────────────
    glGetIntegeri_v: (target, index, dataPtr) => {
      const view = new Int32Array(getMemory().buffer, dataPtr, 1);
      gl.glGetIntegeri_v(target, index, view);
    },
    glGetInteger64v: (pname, paramsPtr) => {
      const result = gl.glGetInteger64v(pname);
      new DataView(getMemory().buffer).setBigInt64(paramsPtr, BigInt(Math.round(result)), true);
    },
    glGetInteger64i_v: (target, index, dataPtr) => {
      // Stub — use 32-bit fallback
      const view = new Int32Array(getMemory().buffer, dataPtr, 1);
      gl.glGetIntegeri_v(target, index, view);
    },

    // ─── Misc queries ────────────────────────────────────────────────
    glGetUniformfv: (program, location, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetUniformfv(program, location, buf);
      new DataView(getMemory().buffer).setFloat32(paramsPtr, buf.readFloatLE(0), true);
    },
    glGetUniformiv: (program, location, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetUniformiv(program, location, buf);
      i32()[paramsPtr >> 2] = buf.readInt32LE(0);
    },
    glGetUniformuiv: (program, location, paramsPtr) => {
      const buf = Buffer.alloc(4);
      gl.glGetUniformuiv(program, location, buf);
      u32()[paramsPtr >> 2] = buf.readUInt32LE(0);
    },
  };

  // Build the full import map including emscripten_gl* aliases and OES/ANGLE/EXT variants
  const result = {};

  // All direct gl* functions
  for (const [name, fn] of Object.entries(funcs)) {
    result[name] = fn;
  }

  // emscripten_gl* duplicates (same implementation, different name)
  for (const [name, fn] of Object.entries(funcs)) {
    result[`emscripten_${name}`] = fn;
  }

  // OES extension aliases (VAO)
  result.glBindVertexArrayOES = funcs.glBindVertexArray;
  result.glDeleteVertexArraysOES = funcs.glDeleteVertexArrays;
  result.glGenVertexArraysOES = funcs.glGenVertexArrays;
  result.glIsVertexArrayOES = funcs.glIsVertexArray;
  result.emscripten_glBindVertexArrayOES = funcs.glBindVertexArray;
  result.emscripten_glDeleteVertexArraysOES = funcs.glDeleteVertexArrays;
  result.emscripten_glGenVertexArraysOES = funcs.glGenVertexArrays;
  result.emscripten_glIsVertexArrayOES = funcs.glIsVertexArray;

  // ANGLE/ARB/EXT/NV instanced drawing aliases
  for (const suffix of ['ANGLE', 'ARB', 'EXT', 'NV']) {
    result[`glDrawArraysInstanced${suffix}`] = funcs.glDrawArraysInstanced;
    result[`glDrawElementsInstanced${suffix}`] = funcs.glDrawElementsInstanced;
    result[`glVertexAttribDivisor${suffix}`] = funcs.glVertexAttribDivisor;
    result[`emscripten_glDrawArraysInstanced${suffix}`] = funcs.glDrawArraysInstanced;
    result[`emscripten_glDrawElementsInstanced${suffix}`] = funcs.glDrawElementsInstanced;
    result[`emscripten_glVertexAttribDivisor${suffix}`] = funcs.glVertexAttribDivisor;
  }

  // WEBGL/EXT draw buffers aliases
  result.glDrawBuffersWEBGL = funcs.glDrawBuffers;
  result.glDrawBuffersEXT = funcs.glDrawBuffers;
  result.emscripten_glDrawBuffersWEBGL = funcs.glDrawBuffers;
  result.emscripten_glDrawBuffersEXT = funcs.glDrawBuffers;

  // EXT query aliases (timer queries)
  result.glGenQueriesEXT = funcs.glGenQueries;
  result.glDeleteQueriesEXT = funcs.glDeleteQueries;
  result.glIsQueryEXT = funcs.glIsQuery;
  result.glBeginQueryEXT = funcs.glBeginQuery;
  result.glEndQueryEXT = funcs.glEndQuery;
  result.glQueryCounterEXT = (id, target) => {}; // timer query — stub
  result.glGetQueryivEXT = funcs.glGetQueryiv;
  result.glGetQueryObjectivEXT = (id, pname, paramsPtr) => { i32()[paramsPtr >> 2] = 0; };
  result.glGetQueryObjectuivEXT = funcs.glGetQueryObjectuiv;
  result.glGetQueryObjecti64vEXT = (id, pname, paramsPtr) => {
    new DataView(getMemory().buffer).setBigInt64(paramsPtr, 0n, true);
  };
  result.glGetQueryObjectui64vEXT = (id, pname, paramsPtr) => {
    new DataView(getMemory().buffer).setBigUint64(paramsPtr, 0n, true);
  };
  result.emscripten_glGenQueriesEXT = result.glGenQueriesEXT;
  result.emscripten_glDeleteQueriesEXT = result.glDeleteQueriesEXT;
  result.emscripten_glIsQueryEXT = result.glIsQueryEXT;
  result.emscripten_glBeginQueryEXT = result.glBeginQueryEXT;
  result.emscripten_glEndQueryEXT = result.glEndQueryEXT;
  result.emscripten_glQueryCounterEXT = result.glQueryCounterEXT;
  result.emscripten_glGetQueryivEXT = result.glGetQueryivEXT;
  result.emscripten_glGetQueryObjectivEXT = result.glGetQueryObjectivEXT;
  result.emscripten_glGetQueryObjectuivEXT = result.glGetQueryObjectuivEXT;
  result.emscripten_glGetQueryObjecti64vEXT = result.glGetQueryObjecti64vEXT;
  result.emscripten_glGetQueryObjectui64vEXT = result.glGetQueryObjectui64vEXT;

  // Polygon mode WEBGL extension — stub
  result.glPolygonModeWEBGL = (face, mode) => {};
  result.emscripten_glPolygonModeWEBGL = result.glPolygonModeWEBGL;

  // Polygon offset clamp EXT — stub
  result.glPolygonOffsetClampEXT = (factor, units, clamp) => gl.glPolygonOffset(factor, units);
  result.emscripten_glPolygonOffsetClampEXT = result.glPolygonOffsetClampEXT;

  // Clip control EXT — stub (not in GLES3 core)
  result.glClipControlEXT = (origin, depth) => {};
  result.emscripten_glClipControlEXT = result.glClipControlEXT;

  // GL call tracing
  if (process.env.GL_TRACE === '1') {
    process.stderr.write(`[libretro-gl-trace] Wrapping ${Object.keys(result).length} GL functions\n`);
    const raw = { ...result };
    for (const name of Object.keys(result)) {
      const orig = raw[name];
      result[name] = (...args) => {
        const ret = orig(...args);
        // Only log non-emscripten variants to avoid double logging
        if (!name.startsWith('emscripten_')) {
          process.stderr.write(`[gl] ${name}(${args.map(a => typeof a === 'number' ? '0x'+a.toString(16) : a).join(',')}) => ${ret}\n`);
        }
        return ret;
      };
    }
  }

  return result;
}
