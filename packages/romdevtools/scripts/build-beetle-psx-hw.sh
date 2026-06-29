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

# Link ALL .o directly (not via the .bc archive — the archive route drops the GLSM/GL
# objects so the core never calls SET_HW_RENDER, same lesson as N64). The GL knobs
# (-lGL + GL_ENABLE_GET_PROC_ADDRESS + "GL" in EXPORTED_RUNTIME_METHODS) make Emscripten
# emit Module["GL"]=GL so the returned module exposes the GL context the host drives.
OBJ_FILES=$(find . -name "*.o" | tr '\n' ' ')
EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_romdev_mips_regs_get","_romdev_spu_get","_malloc","_free","_emscripten_GetProcAddress"]'
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
