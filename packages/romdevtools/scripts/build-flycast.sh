#!/usr/bin/env bash
# Build Flycast (Sega Dreamcast) libretro core → WASM for romdev.
#
# Flycast is a full DC emulator (785 C++ files, GLES3/WebGL2 renderer). It has no
# upstream emscripten build, so this script applies the romdev WASM patches:
#   - DetectArchitecture.cmake + core/build.h: a CPU_GENERIC host (upstream has no
#     emscripten dynarec) + romdev's own WASM SH-4 recompiler in core/rec-wasm.
#     DEFAULT is the recompiler; ROMDEV_FLYCAST_INTERP=1 builds the interpreter.
#   - core/hw/sh4/sh4_core_regs.cpp + core/linux/context.cpp: CPU_GENERIC no-op
#     branches (host-FPU control + JIT segfault recovery don't exist on WASM).
#   - CMakeLists: emscripten libretro build runs asio single-threaded
#     (ASIO_DISABLE_THREADS) so it doesn't need POSIX signal_blocker/tss_ptr.
#   - Vulkan OFF (WASM uses WebGL/GLES); networking/UPnP stubbed.
# Output: src/cores/wasm/flycast_libretro.{js,wasm} (gitignored dev staging).
set -euo pipefail
command -v emcc >/dev/null || { echo "emcc not found (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/flycast"
OUT="$PROJECT_DIR/src/cores/wasm"
REPO="https://github.com/flyinghead/flycast.git"
mkdir -p "$(dirname "$BUILD_DIR")" "$OUT"

[ -d "$BUILD_DIR" ] || git clone --depth 1 "$REPO" "$BUILD_DIR"
cd "$BUILD_DIR"
git submodule update --init --recursive --depth 1

# ── romdev WASM patches (idempotent) ────────────────────────────────────────
# 1. CMake arch detection: emscripten → "wasm" (no rec sources).
if ! grep -q "romdev: emscripten" shell/cmake/DetectArchitecture.cmake; then
  perl -0pi -e 's/(if \(CMAKE_OSX_ARCHITECTURES\)\n    set\(ARCHITECTURE "\$\{CMAKE_OSX_ARCHITECTURES\}"\)\n    return\(\)\nendif\(\))/$1\n\n# romdev: emscripten\/WASM has no JIT.\nif (EMSCRIPTEN)\n    set(ARCHITECTURE "wasm")\n    return()\nendif()/' shell/cmake/DetectArchitecture.cmake
fi
# 2. build.h: CPU_GENERIC for emscripten. DEFAULT = the WASM SH-4 RECOMPILER
#    (core/rec-wasm/rec_wasm.cpp) — this is what romdev-core-flycast 0.3.0+ ships,
#    so a plain `bash build-flycast.sh` reproduces the PUBLISHED core. ~70-160fps on
#    commercial discs vs ~16fps interpreted; AICA (ARM7+DSP) stays interpreted.
#    Set ROMDEV_FLYCAST_INTERP=1 to build the SH-4 interpreter (TARGET_NO_REC)
#    instead — slower but the simplest reference when bisecting a suspected JIT bug.
#
#    History: the "native-emit bugs hang the boot" claim that kept the JIT
#    opt-in through 0.2.0 was WRONG on both counts. The boot hang was a
#    stale-compiled-block SMC hole (fixed via block-code fingerprints), the "emit
#    bugs" were artifacts of a buggy shadow comparator, and the last real hang
#    (a test disc) was a block being executed twice because the dispatch-miss
#    handler called rdv_FailedToFindBlock() AFTER running the block, rewinding pc.
#    See internal-romdev/FLYCAST_WASM_JIT_RESUME.md for the full story.
#
# Single source of truth for the rec mode — every check below reads FLYCAST_JIT.
FLYCAST_JIT=1
if [ "${ROMDEV_FLYCAST_INTERP:-0}" = "1" ]; then
  FLYCAST_JIT=0
fi
# The shadow diagnostic implies the JIT (it compares JIT vs reference).
if [ "${ROMDEV_FLYCAST_SHADOW:-0}" = "1" ]; then
  [ "$FLYCAST_JIT" = "1" ] || { echo "ROMDEV_FLYCAST_SHADOW=1 conflicts with ROMDEV_FLYCAST_INTERP=1"; exit 1; }
fi
FLYCAST_REC_DEFINES='\t#define FEAT_SHREC DYNAREC_JIT\n\t#define FEAT_AREC DYNAREC_NONE\n\t#define FEAT_DSPREC DYNAREC_NONE'
if [ "$FLYCAST_JIT" = "0" ]; then
  FLYCAST_REC_DEFINES='\t#ifndef TARGET_NO_REC\n\t#define TARGET_NO_REC\n\t#endif'
  echo "romdev: building flycast with the SH-4 INTERPRETER (ROMDEV_FLYCAST_INTERP=1)"
fi
if ! grep -q "CPU_GENERIC" core/build.h; then
  sed -i 's/#define CPU_X64      0x20000004/#define CPU_X64      0x20000004\n#define CPU_GENERIC  0x20000005/' core/build.h
  perl -0pi -e "s/(#if defined\\(__x86_64__\\) \\|\\| defined\\(_M_X64\\))/#if defined(__EMSCRIPTEN__)\\n\\t#define HOST_CPU CPU_GENERIC\\n${FLYCAST_REC_DEFINES}\\n#elif defined(__x86_64__) || defined(_M_X64)/" core/build.h
fi
# Re-assert the rec mode EVERY run — the block above is apply-once, so switching
# interpreter <-> JIT on an existing tree would otherwise silently keep the stale
# mode (a "JIT" build with TARGET_NO_REC compiles rec_wasm.cpp to a 333-byte
# empty object and the link dies on the _wasm_* exports).
if [ "$FLYCAST_JIT" = "1" ]; then
  REC_MODE_BLOCK=$'\t#define FEAT_SHREC DYNAREC_JIT\n\t#define FEAT_AREC DYNAREC_NONE\n\t#define FEAT_DSPREC DYNAREC_NONE'
else
  REC_MODE_BLOCK=$'\t#ifndef TARGET_NO_REC\n\t#define TARGET_NO_REC\n\t#endif'
fi
REC_MODE_BLOCK="$REC_MODE_BLOCK" perl -0pi -e 's/(#if defined\(__EMSCRIPTEN__\)\n\t#define HOST_CPU CPU_GENERIC\n).*?(\n#elif defined\(__x86_64__\) \|\| defined\(_M_X64\))/$1$ENV{REC_MODE_BLOCK}$2/s' core/build.h
if [ "$FLYCAST_JIT" = "1" ]; then
  grep -q "FEAT_SHREC DYNAREC_JIT" core/build.h || { echo "FATAL: build.h rec-mode re-assert failed"; exit 1; }
  echo "romdev: build.h rec mode = WASM SH-4 JIT"
else
  grep -q "TARGET_NO_REC" core/build.h || { echo "FATAL: build.h rec-mode re-assert failed"; exit 1; }
  echo "romdev: build.h rec mode = interpreter"
fi
# 3. sh4_core_regs.cpp + context.cpp: CPU_GENERIC no-op.
grep -q "HOST_CPU == CPU_GENERIC" core/hw/sh4/sh4_core_regs.cpp || \
  perl -0pi -e 's/(    #else\n\t#error "SetFloatStatusReg: Unsupported platform")/    #elif HOST_CPU == CPU_GENERIC\n\t(void)roundingMode; (void)denorm2zero;\n$1/' core/hw/sh4/sh4_core_regs.cpp
grep -q "HOST_CPU == CPU_GENERIC" core/linux/context.cpp || \
  perl -0pi -e 's/(#else\n\t#error Unsupported HOST_CPU)/#elif HOST_CPU == CPU_GENERIC\n\t(void)hostctx; (void)segfault_ctx;\n$1/' core/linux/context.cpp
# 4. CMakeLists: emscripten asio single-threaded.
if ! grep -q "romdev: emscripten/WASM libretro build" CMakeLists.txt; then
  perl -0pi -e 's/(\ttarget_compile_definitions\(\$\{PROJECT_NAME\} PRIVATE LIBRETRO\)\n)/$1\tif(EMSCRIPTEN)\n\t\ttarget_compile_definitions(\${PROJECT_NAME} PRIVATE ASIO_STANDALONE ASIO_DISABLE_THREADS ASIO_DISABLE_LOCAL_SOCKETS ASIO_DISABLE_SERIAL_PORT ESHUTDOWN=110 SA_RESTART=0 SA_NOCLDWAIT=0 IMGUI_DISABLE_DEFAULT_SHELL_FUNCTIONS)\n\tendif()\n/' CMakeLists.txt
fi

# 4b. CMakeLists: compile the WASM SH-4 JIT backend for the emscripten target. Added
#     right after the rec-x64 sources block (which ends with the matching `endif()`).
if ! grep -q "core/rec-wasm/rec_wasm.cpp" CMakeLists.txt; then
  perl -0pi -e 's/(\t\t\tcore\/rec-x64\/x64_regalloc\.h\)\n\tendif\(\)\nendif\(\))/$1\n\nif(EMSCRIPTEN)\n\ttarget_sources(\${PROJECT_NAME} PRIVATE core\/rec-wasm\/rec_wasm.cpp)\nendif()/' CMakeLists.txt
fi

# 5. posix_vmem.cpp: decline fast-vmem on emscripten (no 512MB mmap) → malloc fallback.
grep -q "__EMSCRIPTEN__" core/linux/posix_vmem.cpp || \
  perl -0pi -e "s/(bool init\(void \*\*vmem_base_addr, void \*\*sh4rcb_addr, size_t ramSize\)\n\{)/\$1\n#if defined(__EMSCRIPTEN__)\n\t(void)vmem_base_addr; (void)sh4rcb_addr; (void)ramSize; return false;\n#endif/" core/linux/posix_vmem.cpp

# 6. single-threaded WASM: stub worker-thread creation (emscripten can't spawn them
#    without -pthread, and with -pthread the main thread can't block → unwind). The
#    emulation runs synchronously on retro_run (ThreadedRendering defaulted false).
grep -q "romdev/WASM (single-threaded" core/stdclass.cpp || \
  perl -0pi -e 's/(void cThread::Start\(\)\n\{)/$1\n#if defined(__EMSCRIPTEN__)\n\treturn; \/* romdev\/WASM: no worker threads *\/\n#endif/' core/stdclass.cpp
grep -q "romdev/WASM (single-threaded" core/util/worker_thread.h || \
  perl -0pi -e "s/(\tvoid run\(Function&& task\) \{)/\$1\n#if defined(__EMSCRIPTEN__)\n\t\ttask(); return; \/* romdev\/WASM: run inline *\/\n#endif/" core/util/worker_thread.h
grep -q "romdev/WASM (single-threaded" core/util/periodic_thread.h || \
  perl -0pi -e 's/(\tvoid start\(\)\n\t\{)/$1\n#if defined(__EMSCRIPTEN__)\n\t\treturn; \/* romdev\/WASM: no worker threads *\/\n#endif/' core/util/periodic_thread.h
grep -q "romdev/WASM: single-threaded build" shell/libretro/option.cpp || \
  sed -i 's/Option<bool> ThreadedRendering(CORE_OPTION_NAME "_threaded_rendering", true);/#if defined(__EMSCRIPTEN__) \/* romdev\/WASM: single-threaded build *\/\nOption<bool> ThreadedRendering(CORE_OPTION_NAME "_threaded_rendering", false);\n#else\nOption<bool> ThreadedRendering(CORE_OPTION_NAME "_threaded_rendering", true);\n#endif/' shell/libretro/option.cpp

# CPU runs on the worker thread when ThreadedRendering is on — but our pthread no-op
# means that worker never runs (CPU never steps). Force it OFF at runtime (the option
# default isn't enough; the host's option value may not reach update_variables in time).
grep -q "romdev force single-thread" shell/libretro/libretro.cpp || \
  perl -0pi -e 's/(\tif \(first_startup\)\n\t\{\n\t\tif \(config::ThreadedRendering\))/#if defined(__EMSCRIPTEN__)\n\tconfig::ThreadedRendering.override(false); \/\/ romdev force single-thread (no workers in WASM)\n#endif\n$1/' shell/libretro/libretro.cpp

# HLE BIOS (reios) must be ON: only the reios path loads a raw homebrew .elf. We never
# ship a real dc_boot.bin, and the "(Restart Required)" option is latched at retro_init
# before the host can set it — so default it true in the source.
grep -q "romdev/WASM: we never ship" shell/libretro/option.cpp || \
  perl -0pi -e 's/Option<bool> UseReios\(CORE_OPTION_NAME "_hle_bios"\);/#if defined(__EMSCRIPTEN__) \/* romdev\/WASM: we never ship a real dc_boot.bin *\/\nOption<bool> UseReios(CORE_OPTION_NAME "_hle_bios", true);\n#else\nOption<bool> UseReios(CORE_OPTION_NAME "_hle_bios");\n#endif/' shell/libretro/option.cpp

# 7. perf profiling exports (romdev_aica_prof_ms / romdev_gpu_prof_ms). These answer
#    "where is the frame time actually going" once the SH-4 JIT is on: the SH-4 stops
#    being the bottleneck and the remaining cost is the interpreted AICA (ARM7) plus
#    the TA-parse/GL-draw path. Both accumulate wall-ms and reset on read(1).
#    ALWAYS applied (not JIT-gated) so an interpreter build can be measured against a
#    JIT build with the same instrument; the cost is one emscripten_get_now() pair per
#    AICA sample tick / per rendered frame. The matching _romdev_*_prof_ms entries are
#    in BASE_EXPORTS below — if you drop these patches, drop those too, or the link
#    silently omits them (ERROR_ON_UNDEFINED_SYMBOLS=0) and the host sees no export.
grep -q "romdev_aica_prof_ms" core/hw/aica/aica.cpp || \
  perl -0pi -e 's/(static int AicaUpdate\(int tag, int cycles, int jitter, void \*arg\)\n\{\n)(\targm::run\(1\);|\tarm::run\(1\);)/#include <emscripten.h>\ndouble g_aica_prof_ms = 0.0;\nextern "C" EMSCRIPTEN_KEEPALIVE double romdev_aica_prof_ms(int reset){ double v=g_aica_prof_ms; if(reset) g_aica_prof_ms=0.0; return v; }\n\n$1\tdouble _t0 = emscripten_get_now();\n$2\n\tg_aica_prof_ms += emscripten_get_now() - _t0;/' core/hw/aica/aica.cpp
grep -q "romdev_aica_prof_ms" core/hw/aica/aica.cpp || { echo "FATAL: aica prof patch failed to apply"; exit 1; }
grep -q "romdev_gpu_prof_ms" core/hw/pvr/Renderer_if.cpp || {
  perl -0pi -e 's/(#include <mutex>\n)/$1#include <emscripten.h>\ndouble g_gpu_prof_ms = 0.0;\nextern "C" EMSCRIPTEN_KEEPALIVE double romdev_gpu_prof_ms(int reset){ double v=g_gpu_prof_ms; if(reset) g_gpu_prof_ms=0.0; return v; }\nstruct RomdevGpuTimer { double t0; RomdevGpuTimer(){ t0 = emscripten_get_now(); } ~RomdevGpuTimer(){ g_gpu_prof_ms += emscripten_get_now() - t0; } };\n/' core/hw/pvr/Renderer_if.cpp
  perl -0pi -e 's/(\n\t\t\{\n\t\t\tFC_PROFILE_SCOPE_NAMED\("Renderer::Process"\);)/\n\t\tRomdevGpuTimer _rgt; \/\/ times TA-parse (Process) + GL draw (Render) + present$1/' core/hw/pvr/Renderer_if.cpp
}
grep -q "romdev_gpu_prof_ms" core/hw/pvr/Renderer_if.cpp || { echo "FATAL: gpu prof patch failed to apply"; exit 1; }
grep -q "RomdevGpuTimer _rgt" core/hw/pvr/Renderer_if.cpp || { echo "FATAL: gpu prof timer scope failed to apply"; exit 1; }

# ── stage the WASM SH-4 JIT backend into the tree ───────────────────────────
# rec_wasm.cpp emits wasm bytecode at runtime (WebAssembly.compile + table.grow +
# call_indirect). CMakeLists compiles it for EMSCRIPTEN (target_sources added above).
mkdir -p core/rec-wasm
cp "$SCRIPT_DIR/patches/flycast-wasm-jit/rec_wasm.cpp"          core/rec-wasm/
cp "$SCRIPT_DIR/patches/flycast-wasm-jit/wasm_module_builder.h" core/rec-wasm/
cp "$SCRIPT_DIR/patches/flycast-wasm-jit/wasm_emit.h"           core/rec-wasm/
cp "$SCRIPT_DIR/patches/flycast-wasm-jit/fly_instrument.h"      core/rec-wasm/
cp "$SCRIPT_DIR/patches/flycast-wasm-jit/wasm_test_shil_ops.h"  core/rec-wasm/
echo "romdev: staged WASM SH-4 JIT backend into core/rec-wasm/"

# ── configure + build ───────────────────────────────────────────────────────
# JIT-only extra defines: JIT_PROD_BUILD (drop the dev EM_ASM logging + the
#   wasm_test_shil_ops self-test) + -fexceptions (the JIT block-exit/MMU-fault path
#   uses C++ exceptions). The interpreter build needs neither.
JIT_CXX_FLAGS=""
JIT_C_FLAGS=""
if [ "$FLYCAST_JIT" = "1" ]; then
  JIT_CXX_FLAGS="-DJIT_PROD_BUILD -fexceptions"
  JIT_C_FLAGS="-DJIT_PROD_BUILD"
fi
# ROMDEV_FLYCAST_SHADOW=1 → the JIT-vs-reference SHADOW diagnostic (implies JIT):
#   EXECUTOR_MODE 7 (every block runs through BOTH the native JIT and the
#   reference interpreter, Sh4Context compared byte-by-byte, [SHADOW-JIT]
#   MISMATCH logged with exact block/op/register), FORCE_CPP_DISPATCH 1, and
#   NO JIT_PROD_BUILD (the shadow machinery + logging are #ifndef-gated on it).
#   Optional ROMDEV_FLYCAST_FALLBACK_MASK=0xNN forces op categories to the
#   interpreter fallback (bit 6 = readm) for differential isolation.
#   Run the result with ROMDEV_CORE_LOG=1 and grep for SHADOW-JIT.
if [ "${ROMDEV_FLYCAST_SHADOW:-0}" = "1" ]; then
  JIT_CXX_FLAGS="-fexceptions -DEXECUTOR_MODE=7 -DFORCE_CPP_DISPATCH=1"
  JIT_C_FLAGS=""
  # Default mask 0x200 = writem via the captured shil fallback. The shadow's
  # side-effect rollback NEEDS every write captured (native JIT stores are
  # invisible to it); without this, read-modify-write-through-memory blocks
  # produce guaranteed false mismatches. Override to test writem's native
  # emit only AFTER everything else converges.
  ROMDEV_FLYCAST_FALLBACK_MASK="${ROMDEV_FLYCAST_FALLBACK_MASK:-0x200}"
  JIT_CXX_FLAGS="$JIT_CXX_FLAGS -DFLY_FORCE_FALLBACK_MASK=${ROMDEV_FLYCAST_FALLBACK_MASK}"
  echo "romdev: SHADOW diagnostic build (EXECUTOR_MODE 7, no JIT_PROD_BUILD, mask=${ROMDEV_FLYCAST_FALLBACK_MASK})"
fi
rm -rf build-em && mkdir build-em && cd build-em
emcmake cmake .. -DLIBRETRO=ON -DUSE_VULKAN=OFF -DUSE_GLES=ON -DUSE_GLES2=OFF -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="$JIT_CXX_FLAGS" -DCMAKE_C_FLAGS="$JIT_C_FLAGS"

emmake make flycast_libretro -j"$(nproc)"

# pthread no-op wrapper (single-threaded build): compile it + --wrap the pthread fns.
emcc -O2 -c "$SCRIPT_DIR/patches/romdev-snippets/flycast-pthread-noop.c" -o /tmp/flycast-pthread-noop.o

# romdev debug exports (cpuState SH-4 + audioDebug AICA). Compiled C++ against the
# flycast core headers (Sh4cntx in sh4_if.h, aica_reg in aica_mem.h). em++ so the
# extern "C" exports link cleanly into the module.
em++ -O2 -c "$SCRIPT_DIR/patches/romdev-snippets/flycast-debug.c" -o /tmp/flycast-debug.o \
  -I"$BUILD_DIR/core" -I"$BUILD_DIR/core/deps" -I"$BUILD_DIR/core/deps/nowide/include" \
  -I"$BUILD_DIR/core/deps/glm" -I"$BUILD_DIR/core/deps/stb" -I"$BUILD_DIR/core/deps/xxHash" \
  -std=c++17 -DTARGET_NO_OPENMP -DLIBRETRO -DTARGET_NO_THREADS

# ── link all archives → one WASM module ─────────────────────────────────────
LIBS="libflycast_libretro.a libflycast-resources.a core/deps/libelf/libelf.a core/deps/nowide/libnowide.a core/deps/miniupnpc/libminiupnpc.a core/deps/libchdr/libchdr-static.a core/deps/tinygettext/libtinygettext.a core/deps/libzip/lib/libzip.a core/deps/xxHash/cmake_unofficial/libxxhash.a core/deps/libchdr/deps/zlib-*/libz.a core/deps/libchdr/deps/lzma-*/liblzma.a core/deps/libchdr/deps/zstd-*/build/cmake/lib/libzstd.a"
# Base exports (interpreter). The JIT build ADDS the _wasm_* memory-access + fallback
# imports the EM_JS glue in rec_wasm.cpp binds into each runtime-compiled block module
# (export them explicitly so DCE can't drop them), + wasmExports/wasmTable/wasmMemory
# runtime methods + -fexceptions. The interpreter needs none of these.
BASE_EXPORTS='"_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_romdev_sh4_regs_get","_romdev_aica_get","_romdev_dc_kcode_get","_romdev_aica_prof_ms","_romdev_jit_stats","_romdev_gpu_prof_ms","_malloc","_free","_emscripten_GetProcAddress"'
BASE_RT='"ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall","GL"'
JIT_LINK_FLAGS=""
if [ "$FLYCAST_JIT" = "1" ]; then
  BASE_EXPORTS="$BASE_EXPORTS,\"_wasm_mem_read8\",\"_wasm_mem_read16\",\"_wasm_mem_read32\",\"_wasm_mem_write8\",\"_wasm_mem_write16\",\"_wasm_mem_write32\",\"_wasm_exec_ifb\",\"_wasm_exec_shil_fb\""
  BASE_RT="$BASE_RT,\"wasmExports\",\"wasmTable\",\"wasmMemory\""
  JIT_LINK_FLAGS="-fexceptions -s DISABLE_EXCEPTION_CATCHING=0"
fi
EXPORTED="[$BASE_EXPORTS]"
EXPORTED_RT="[$BASE_RT]"
emcc /tmp/flycast-pthread-noop.o /tmp/flycast-debug.o $LIBS -O3 $JIT_LINK_FLAGS -Wl,--wrap=pthread_create -Wl,--wrap=pthread_join -Wl,--wrap=pthread_detach -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s "EXPORT_NAME=create_flycast" \
  -s "ENVIRONMENT=node,web" -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=536870912 \
  -s MAXIMUM_MEMORY=1073741824 -s STACK_SIZE=4194304 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s NODERAWFS=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 -s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2 \
  -s FULL_ES3=1 -s GL_ENABLE_GET_PROC_ADDRESS=1 -lGL -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o "$OUT/flycast_libretro.js"
sed -i 's/var GL={/var GL=Module.GL={/' "$OUT/flycast_libretro.js" 2>/dev/null || true
echo "Built: $OUT/flycast_libretro.{js,wasm}"
