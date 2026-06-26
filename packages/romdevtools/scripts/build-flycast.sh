#!/usr/bin/env bash
# Build Flycast (Sega Dreamcast) libretro core → WASM for romdev.
#
# Flycast is a full DC emulator (785 C++ files, GLES3/WebGL2 renderer). It has no
# upstream emscripten build, so this script applies the romdev WASM patches:
#   - DetectArchitecture.cmake + core/build.h: a CPU_GENERIC host (no JIT) → the
#     SH-4/ARM/DSP INTERPRETERS (TARGET_NO_REC). emscripten has no dynarec.
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
# 2. build.h: CPU_GENERIC + TARGET_NO_REC for emscripten.
if ! grep -q "CPU_GENERIC" core/build.h; then
  sed -i 's/#define CPU_X64      0x20000004/#define CPU_X64      0x20000004\n#define CPU_GENERIC  0x20000005/' core/build.h
  perl -0pi -e 's/(#if defined\(__x86_64__\) \|\| defined\(_M_X64\))/#if defined(__EMSCRIPTEN__)\n\t#define HOST_CPU CPU_GENERIC\n\t#ifndef TARGET_NO_REC\n\t#define TARGET_NO_REC\n\t#endif\n#elif defined(__x86_64__) || defined(_M_X64)/' core/build.h
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

# ── configure + build ───────────────────────────────────────────────────────
rm -rf build-em && mkdir build-em && cd build-em
emcmake cmake .. -DLIBRETRO=ON -DUSE_VULKAN=OFF -DUSE_GLES2=OFF -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-pthread" -DCMAKE_CXX_FLAGS="-pthread"
emmake make flycast_libretro -j"$(nproc)"

# ── link all archives → one WASM module ─────────────────────────────────────
LIBS="libflycast_libretro.a libflycast-resources.a core/deps/libelf/libelf.a core/deps/nowide/libnowide.a core/deps/miniupnpc/libminiupnpc.a core/deps/libchdr/libchdr-static.a core/deps/tinygettext/libtinygettext.a core/deps/libzip/lib/libzip.a core/deps/xxHash/cmake_unofficial/libxxhash.a core/deps/libchdr/deps/zlib-*/libz.a core/deps/libchdr/deps/lzma-*/liblzma.a core/deps/libchdr/deps/zstd-*/build/cmake/lib/libzstd.a"
EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free","_emscripten_GetProcAddress"]'
EXPORTED_RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall","GL"]'
emcc $LIBS -O2 -pthread -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s "EXPORT_NAME=create_flycast" \
  -s "ENVIRONMENT=node,web,worker" -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=536870912 \
  -s MAXIMUM_MEMORY=1073741824 -s STACK_SIZE=4194304 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 -s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2 \
  -s FULL_ES3=1 -s GL_ENABLE_GET_PROC_ADDRESS=1 -lGL -s PTHREAD_POOL_SIZE=8 -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o "$OUT/flycast_libretro.js"
sed -i 's/var GL={/var GL=Module.GL={/' "$OUT/flycast_libretro.js" 2>/dev/null || true
echo "Built: $OUT/flycast_libretro.{js,wasm}"
