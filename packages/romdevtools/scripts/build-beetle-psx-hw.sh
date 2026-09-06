#!/usr/bin/env bash
# Build Beetle PSX HW (Sony PlayStation) libretro core → WASM, GL-RENDERED.
#
# The PS1 GPU renders on the REAL GPU through native-gles: beetle's GLES3 hardware
# renderer (rhi_lib_gl) draws to WebGL2, the host owns the EGL pbuffer via native-gles,
# and we glReadPixels the frame back — the same GPU path as glide64-N64 + Flycast-DC.
# OpenBIOS (PCSX-Redux, MIT, region-free) is EMBEDDED in the core source, so there is no
# copyrighted Sony firmware to ship and no BIOS file to supply.
set -euo pipefail
command -v emcc >/dev/null || { echo "emcc not found (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/beetle_psx_hw"
SRC="$BUILD_DIR/src"
OUT="$PROJECT_DIR/src/cores/wasm"
REPO="https://github.com/libretro/beetle-psx-libretro.git"
mkdir -p "$BUILD_DIR" "$OUT"

[ -d "$SRC/.git" ] || git clone --depth 1 "$REPO" "$SRC"
cd "$SRC"

# ── romdev debug exports (cpuState + audioDebug) ──────────────────────────────
# cpuState: R3000A register snapshot appended to cpu.c (GPR/BACKED_PC macros in scope).
# audioDebug: SPU register block appended to spu.c (the static raw `regs` mirror in
# scope — we read regs.Regs[] directly, NOT SPU_Read, since SPU_Read quantizes the
# volume/sweep registers). Both idempotent. They light up cpu({op:'read'}) +
# audioDebug({op:'inspect',chip:'spu'}) with zero host changes — the host's
# *Supported() checks just probe for the exports.
CPU_C="mednafen/psx/cpu.c"
if ! grep -q "romdev_mips_regs_get" "$CPU_C"; then
  cat "$SCRIPT_DIR/patches/romdev-snippets/beetle-psx-regsnap.c" >> "$CPU_C"
  echo "romdev: appended beetle-psx-regsnap.c to $CPU_C"
fi
SPU_C="mednafen/psx/spu.c"
if ! grep -q "romdev_spu_get" "$SPU_C"; then
  cat "$SCRIPT_DIR/patches/romdev-snippets/beetle-psx-spu.c" >> "$SPU_C"
  echo "romdev: appended beetle-psx-spu.c to $SPU_C"
fi

# ── romdev live-debug instrumentation (0.80.0): the FULL debug surface (watchpoints,
# pc-break, single-step, range, coverage, watchdog) on the ACTIVE GL PS1 core, via the
# SHARED romdev_debug.{h,c} + a thin beetle shim appended to cpu.c (GPR/BACKED_PC in
# scope). The WASM build is interpreter-only (HAVE_LIGHTREC=0), so CPU_RunReal fires.
if ! grep -q "romdev_beetle_step" "$CPU_C"; then
  RDBG_SRC="$(cd "$SCRIPT_DIR/romdev-debug" && pwd)"
  cp "$RDBG_SRC/romdev_debug.h" mednafen/psx/romdev_debug.h
  cp "$RDBG_SRC/romdev_debug.c" mednafen/psx/romdev_debug.c
  # shim appended to cpu.c (after the regsnap) so GPR/BACKED_PC/LO resolve to s_cpu.
  cat "$SCRIPT_DIR/patches/romdev-snippets/beetle-psx-debug.c" >> "$CPU_C"
  # write-watch + range-write: hook each WriteMemory_u{8,16,32} entry.
  perl -0pi -e 's/(static INLINE void WriteMemory_u8\(int32_t \*timestamp, uint32_t address, uint32_t value\)\n\{)/extern void romdev_beetle_write(uint32_t,uint32_t);\n$1\n   romdev_beetle_write(address, value);/ unless /romdev_beetle_write\(address, value\);\n\}/' "$CPU_C";
  perl -0pi -e 's/(static INLINE void WriteMemory_u16\(int32_t \*timestamp, uint32_t address, uint32_t value\)\n\{)/$1\n   romdev_beetle_write(address, value);/ unless /WriteMemory_u16[^{]*\{\n   romdev_beetle_write/s' "$CPU_C";
  perl -0pi -e 's/(static INLINE void WriteMemory_u32\(int32_t \*timestamp, uint32_t address, uint32_t value, bool DS24\)\n\{)/$1\n   romdev_beetle_write(address, value);/ unless /WriteMemory_u32[^{]*\{\n   romdev_beetle_write/s' "$CPU_C";
  # read-watch: hook each ReadMemory_u{8,16,32} entry.
  perl -0pi -e 's/(static INLINE uint8_t ReadMemory_u8\(int32_t \*timestamp, uint32_t address\)\n\{)/extern void romdev_beetle_read(uint32_t);\n$1\n   romdev_beetle_read(address);/ unless /romdev_beetle_read\(address\);/' "$CPU_C";
  perl -0pi -e 's/(static INLINE uint16_t ReadMemory_u16\(int32_t \*timestamp, uint32_t address\)\n\{)/$1\n   romdev_beetle_read(address);/ unless /ReadMemory_u16[^{]*\{\n   romdev_beetle_read/s' "$CPU_C";
  perl -0pi -e 's/(static INLINE uint32_t ReadMemory_u32\(int32_t \*timestamp, uint32_t address, bool DS24, bool LWC_timing\)\n\{)/$1\n   romdev_beetle_read(address);/ unless /ReadMemory_u32[^{]*\{\n   romdev_beetle_read/s' "$CPU_C";
  # pc-break + coverage + single-step: at the top of the CPU_RunReal loop body, where PC
  # is the instruction about to execute (the unique `GPR[0] = 0;` inside the run loop).
  # On a freeze, force the loop to exit cleanly (timestamp = next_event_ts; break).
  perl -0pi -e 's/(\n   GPR\[0\] = 0;\n)/\n   { extern int romdev_beetle_step(uint32_t); if (romdev_beetle_step(PC)) { timestamp = next_event_ts; break; } }$1/ unless /if \(romdev_beetle_step\(PC\)\)/' "$CPU_C";
  echo "romdev: instrumented $CPU_C (write/read/step hooks + shared lib)"
fi

# The emscripten target already enables HAVE_OPENGL/GLES/GLES3 + libchdr (CHD discs).
emmake make platform=emscripten clean >/dev/null 2>&1 || true
emmake make platform=emscripten -j"$(nproc)"

# Extra libretro-common sources the Makefile misses for the emscripten target (the same
# class as the N64 build): file/stream/vfs/dir/threads/hash. Without them the link aborts
# on undefined filestream_*/retro_opendir/scond_*/sha1_calculate at runtime.
INCLUDES="-I./libretro-common/include -I. -I./mednafen -I./mednafen/include"
DEFINES="-DEMSCRIPTEN -D__LIBRETRO__ -DHAVE_OPENGLES -DHAVE_OPENGLES3 -D_FILE_OFFSET_BITS=64 -fPIC"
EXTRAS="
  libretro-common/streams/file_stream.c
  libretro-common/streams/file_stream_transforms.c
  libretro-common/vfs/vfs_implementation.c
  libretro-common/file/file_path.c
  libretro-common/file/file_path_io.c
  libretro-common/file/retro_dirent.c
  libretro-common/lists/dir_list.c
  libretro-common/lists/string_list.c
  libretro-common/string/stdstring.c
  libretro-common/compat/compat_strl.c
  libretro-common/compat/compat_strcasestr.c
  libretro-common/compat/compat_posix_string.c
  libretro-common/encodings/encoding_utf.c
  libretro-common/rthreads/rthreads.c
  libretro-common/hash/rhash.c
  libretro-common/memmap/memalign.c"
for src in $EXTRAS; do
  obj="${src%.c}.o"
  [ -f "$obj" ] || emcc -O3 -flto -c "$src" -o "$obj" $INCLUDES $DEFINES 2>/dev/null
done

# Always refresh the SHARED debug lib (the fresh-tree block above only runs once; a
# rebuilt tree would otherwise link the old lib and the linker would miss any export
# added since — 0.13.0's romdev_covbits_*).
RDBG_SRC="$(cd "$SCRIPT_DIR/romdev-debug" && pwd)"
cp "$RDBG_SRC/romdev_debug.h" mednafen/psx/romdev_debug.h
cp "$RDBG_SRC/romdev_debug.c" mednafen/psx/romdev_debug.c
rm -f mednafen/psx/romdev_debug.o
# Compile the shared romdev_debug.c (the make picks up cpu.c's appended shim itself).
emcc -O3 -flto -c mednafen/psx/romdev_debug.c -o mednafen/psx/romdev_debug.o $INCLUDES $DEFINES

# Link ALL .o directly (not via the .bc archive — the archive route drops the GLSM/GL
# objects so the core never calls SET_HW_RENDER, same lesson as N64). The GL knobs
# (-lGL + GL_ENABLE_GET_PROC_ADDRESS + "GL" in EXPORTED_RUNTIME_METHODS) make Emscripten
# emit Module["GL"]=GL so the returned module exposes the GL context the host drives.
OBJ_FILES=$(find . -name "*.o" | tr '\n' ' ')
EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_romdev_mips_regs_get","_romdev_spu_get","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_watchdog_set","_romdev_irqblock_set","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_covbits_set","_romdev_covbits_get","_romdev_regsnap_get","_malloc","_free","_emscripten_GetProcAddress"]'
EXPORTED_RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall","GL"]'

emcc $OBJ_FILES -O3 -flto -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_beetle_psx_hw" -s "ENVIRONMENT=node,web" -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=268435456 -s MAXIMUM_MEMORY=1073741824 -s STACK_SIZE=4194304 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 \
  -s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2 -s FULL_ES3=1 \
  -s GL_ENABLE_GET_PROC_ADDRESS=1 -lGL \
  -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
  -o "$OUT/beetle_psx_hw_libretro.js"

# Module.GL must be reachable for the host's LibretroGL proc-address bridge.
sed -i 's/var GL={/var GL=Module.GL={/' "$OUT/beetle_psx_hw_libretro.js" 2>/dev/null || true

echo "Built: $OUT/beetle_psx_hw_libretro.{js,wasm} (GLES3 HW / native-gles, OpenBIOS embedded)"

# Stage into the carved-out binary package the registry actually resolves at runtime
# (src/cores/registry.js → romdev-core-beetle-psx-hw). Without this the dev tree keeps
# loading the OLD package copy and a rebuild appears to "do nothing".
PKG_OUT="$PROJECT_DIR/../romdev-core-beetle-psx-hw/wasm"
if [ -d "$PKG_OUT" ]; then
  cp "$OUT/beetle_psx_hw_libretro.js"   "$PKG_OUT/beetle_psx_hw_libretro.js"
  cp "$OUT/beetle_psx_hw_libretro.wasm" "$PKG_OUT/beetle_psx_hw_libretro.wasm"
  echo "also staged into romdev-core-beetle-psx-hw package: $PKG_OUT"
fi
