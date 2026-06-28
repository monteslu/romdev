#!/usr/bin/env bash
# Build PPSSPP (Sony PSP) libretro core → WASM, GL-RENDERED via native-gles.
#
# The PSP GE renders on the REAL GPU through native-gles: PPSSPP's GLES2 backend draws to
# WebGL2 (the same renderer it uses on Android), the host owns the EGL pbuffer via
# native-gles, and we glReadPixels the frame back — the same GPU path as glide64-N64 /
# beetle-PS1 / flycast-DC. PPSSPP is full HLE: NO Sony firmware (it bundles its own open
# Roboto font replacement). Interpreter-only under WASM (no native JIT), which is fine for
# build/boot/screenshot/inspect.
#
# PPSSPP is a large C++ codebase with many git submodules and was written assuming a native
# (x86/ARM) target — emscripten defines __i386__ for its SSE→WASM-SIMD emulation, which trips
# a pile of "this is x86" codepaths that emit inline asm / x86-only intrinsics WASM can't
# build. This script clones + inits the needed submodules and applies the emscripten patches.
set -euo pipefail
command -v emcc >/dev/null || { echo "emcc not found (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/ppsspp"
SRC="$BUILD_DIR"
OUT="$PROJECT_DIR/src/cores/wasm"
REPO="https://github.com/hrydgard/ppsspp.git"
mkdir -p "$OUT"

if [ ! -d "$SRC/.git" ]; then
  git clone "$REPO" "$SRC"
fi
cd "$SRC"

# Submodules the libretro emscripten build actually compiles from (NOT ffmpeg/pspautotests/
# SDL/MoltenVK/freetype/nanosvg/etc. — those aren't in the emscripten source set).
for sub in libretro/libretro-common ext/armips ext/glslang ext/SPIRV-Cross ext/rapidjson \
           ext/zstd ext/cpu_features ext/snappy ext/discord-rpc ext/miniupnp ext/lua \
           ext/libchdr ext/rcheevos ext/OpenXR-SDK ext/aemu_postoffice; do
  if [ ! "$(ls -A "$SRC/$sub" 2>/dev/null)" ]; then
    git submodule update --init --recursive "$sub"
  fi
done

# ── emscripten/WASM patches (each fixes an x86-assumption that breaks under wasm) ──

# (1) Drop the x86 SSE compile flags from the emscripten target's PLATCFLAGS? NO — keep them.
#     PPSSPP relies on emscripten's SSE→WASM-SIMD emulation, so -msse3/-mssse3/-msse4.1 stay.
#     The breakage is specific intrinsics emscripten does NOT emulate; patched at the source.

# (2) Common/CommonFuncs.h: under emscripten the <x86intrin.h> umbrella pulls <ia32intrin.h>
#     whose readeflags/crc32/rdtsc/wbinvd builtins have no WASM lowering. Use the narrower
#     <immintrin.h>, and route __rotl/__rotr to the portable fallback (the x86 __rold/__rord
#     come from ia32intrin.h).
F=Common/CommonFuncs.h
if ! grep -q "romdev:" "$F"; then
  perl -0pi -e 's{#elif \(PPSSPP_ARCH\(X86\) \|\| PPSSPP_ARCH\(AMD64\)\)\n#include <x86intrin\.h>}{#elif defined(__EMSCRIPTEN__)\n// romdev: <x86intrin.h> pulls ia32intrin.h (readeflags/crc32/rdtsc — no WASM lowering).\n#include <immintrin.h>\n#elif (PPSSPP_ARCH(X86) || PPSSPP_ARCH(AMD64))\n#include <x86intrin.h>}' "$F"
  perl -0pi -e 's{#elif \(PPSSPP_ARCH\(X86\) \|\| PPSSPP_ARCH\(AMD64\)\)\n\treturn __rold\(x, shift\);}{#elif (PPSSPP_ARCH(X86) || PPSSPP_ARCH(AMD64)) \&\& !defined(__EMSCRIPTEN__)\n\treturn __rold(x, shift);}' "$F"
  perl -0pi -e 's{#elif \(PPSSPP_ARCH\(X86\) \|\| PPSSPP_ARCH\(AMD64\)\)\n\treturn __rord\(x, shift\);}{#elif (PPSSPP_ARCH(X86) || PPSSPP_ARCH(AMD64)) \&\& !defined(__EMSCRIPTEN__)\n\treturn __rord(x, shift);}' "$F"
  # the first guarded block at the top of the file (line ~33) — also exclude emscripten.
  perl -0pi -e 's{#if \(PPSSPP_ARCH\(X86\) \|\| PPSSPP_ARCH\(AMD64\)\)(\n#include <nmmintrin\.h>)}{#if (PPSSPP_ARCH(X86) || PPSSPP_ARCH(AMD64)) \&\& !defined(__EMSCRIPTEN__)$1}' "$F" 2>/dev/null || true
fi

# (3) Core/MIPS/IR/IRInterpreter.cpp: _mm_getcsr/_mm_setcsr (MXCSR FP-rounding control) has no
#     WASM equivalent. Skip host-rounding replication under emscripten (minor accuracy detail).
F=Core/MIPS/IR/IRInterpreter.cpp
perl -0pi -e 's{#if PPSSPP_ARCH\(SSE2\)\n\t\tu32 csr = _mm_getcsr\(\) & ~0x6000;}{#if PPSSPP_ARCH(SSE2) \&\& !defined(__EMSCRIPTEN__)\n\t\tu32 csr = _mm_getcsr() \& ~0x6000;}' "$F"
perl -0pi -e 's{#if PPSSPP_ARCH\(SSE2\)\n\t// TODO: We should avoid this if we didn.t apply rounding}{#if PPSSPP_ARCH(SSE2) \&\& !defined(__EMSCRIPTEN__)\n\t// TODO: We should avoid this if we didn'"'"'t apply rounding}' "$F"

# (4) ext/libchdr LZMA CpuArch.h: emscripten's __i386__ makes it pick MY_CPU_X86 → CpuArch.c
#     compiles x86 `cpuid` inline asm (whole file is gated on MY_CPU_X86_OR_AMD64). Exclude.
F=ext/libchdr/deps/lzma-24.05/include/CpuArch.h
perl -0pi -e 's{#if  defined\(_M_IX86\) \\\n  \|\| defined\(__i386__\)\n  #define MY_CPU_X86}{#if (defined(_M_IX86) \\\n  || defined(__i386__)) \&\& !defined(__EMSCRIPTEN__) \&\& !defined(__wasm__)\n  #define MY_CPU_X86}' "$F"

# (5) ext/libchdr dr_flac.h: same x86 cpuid asm under DRFLAC_X86.
F=ext/libchdr/include/dr_libs/dr_flac.h
perl -0pi -e 's{#elif defined\(__i386\) \|\| defined\(_M_IX86\)\n    #define DRFLAC_X86}{#elif (defined(__i386) || defined(_M_IX86)) \&\& !defined(__EMSCRIPTEN__)\n    #define DRFLAC_X86}' "$F"

# (6) ext/cpu_features hwcaps.c: no ELF aux vector on WASM. Stub GetElfHwcapFromGetauxval (the
#     SIMD path is chosen at compile time via -msimd128, not probed at runtime).
F=ext/cpu_features/src/hwcaps.c
if ! grep -q "__EMSCRIPTEN__" "$F"; then
  perl -0pi -e 's{#if defined\(HAVE_STRONG_GETAUXVAL\)\n#include <sys/auxv\.h>}{#if defined(__EMSCRIPTEN__)\nstatic unsigned long GetElfHwcapFromGetauxval(uint32_t t){(void)t;return 0;}\n#elif defined(HAVE_STRONG_GETAUXVAL)\n#include <sys/auxv.h>}' "$F"
fi
# and don't force-claim getauxval on emscripten in the Makefile.
F=libretro/Makefile.common
perl -0pi -e 's{^COREFLAGS \+= -DHAVE_STRONG_GETAUXVAL}{ifneq (\$(platform), emscripten)\nCOREFLAGS += -DHAVE_STRONG_GETAUXVAL\nendif}m' "$F"

# (7) ext/aemu_postoffice sock_impl_linux.c: SO_NOSIGPIPE (BSD socket opt) not on emscripten.
F=ext/aemu_postoffice/client/sock_impl_linux.c
perl -0pi -e 's{\t#ifndef __linux__}{\t#if !defined(__linux__) \&\& !defined(__EMSCRIPTEN__)}g' "$F"

# ── compile (produces 800+ .o + the .bc archive) ──
cd "$SRC/libretro"
emmake make platform=emscripten clean >/dev/null 2>&1 || true
emmake make platform=emscripten -j"$(nproc)"

# ── link ALL .o directly (NOT the .bc archive — the archive route drops GL objects so the
#    core never calls SET_HW_RENDER). Exclude armips' precompiled MIPS test fixtures. ──
OBJ_FILES=$(find "$SRC" -name "*.o" | grep -vE "/Tests/|/test/|/tests/|object_code" | tr '\n' ' ')
EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free","_emscripten_GetProcAddress"]'
EXPORTED_RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall","GL"]'

# PSP wants big memory (32MB main + upscale buffers); -pthread with a real pool (PPSSPP is
# heavily threaded — POOL_SIZE=0 aborts on the first thread spawn). GL knobs identical to the
# other 3D cores: -lGL + GL_ENABLE_GET_PROC_ADDRESS + "GL" in EXPORTED_RUNTIME_METHODS.
emcc $OBJ_FILES -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_ppsspp" -s "ENVIRONMENT=node,web" -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=536870912 -s MAXIMUM_MEMORY=2147483648 -s STACK_SIZE=8388608 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 \
  -s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2 -s FULL_ES3=1 \
  -s GL_ENABLE_GET_PROC_ADDRESS=1 -lGL \
  -pthread -s PTHREAD_POOL_SIZE=8 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -o "$OUT/ppsspp_libretro.js"

# Module.GL must be reachable for the host's LibretroGL native-gles bridge.
sed -i 's/var GL={/var GL=Module.GL={/' "$OUT/ppsspp_libretro.js" 2>/dev/null || true

echo "Built: $OUT/ppsspp_libretro.{js,wasm} (GLES2 HW / native-gles, HLE no-BIOS)"
