#!/usr/bin/env bash
# Build ParaLLEl-N64 (Nintendo 64) libretro core → WASM, with:
#   - the cheat interface exported (_retro_cheat_set/_retro_cheat_reset)
#   - romdev's R4300 register snapshot appended + exported (_romdev_mips_regs_get)
#     for cpu({op:'read'}) via host.getMipsRegs().
# HW-rendered (glide64 GL): the host drives it through the OPTIONAL native-gles +
# webgl-node bridge. Output: src/cores/wasm/parallel_n64_libretro.{js,wasm}.
set -euo pipefail
command -v emcc >/dev/null || { echo "emcc not found (source emsdk_env.sh)"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${ROMDEV_BUILD_DIR:-$PROJECT_DIR/build}/parallel_n64"
SRC="$BUILD_DIR/src"
OUT="$PROJECT_DIR/src/cores/wasm"
REPO="https://github.com/libretro/parallel-n64.git"
mkdir -p "$BUILD_DIR" "$OUT"

[ -d "$SRC" ] || git clone --depth 1 "$REPO" "$SRC"
cd "$SRC"

# Emscripten Makefile compatibility (upstream visibility flags + GLSM signature).
grep -q "fno-common" Makefile 2>/dev/null || { sed -i 's/-fvisibility=hidden//g; s/-fvisibility-inlines-hidden//g' Makefile; }
if grep -q "rglBlendFuncSeparate(GLenum sfactor, GLenum dfactor)" libretro-common/glsm/glsm.c 2>/dev/null; then
  sed -i 's/void rglBlendFuncSeparate(GLenum sfactor, GLenum dfactor)/void rglBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB, GLenum srcAlpha, GLenum dstAlpha)/' libretro-common/glsm/glsm.c
fi

# Append the R4300 regsnap to libretro.c (idempotent).
if ! grep -q "romdev_mips_regs_get" libretro/libretro.c; then
  cat "$SCRIPT_DIR/patches/romdev-snippets/n64-regsnap.c" >> libretro/libretro.c
  rm -f libretro/libretro.o
fi

# romdev live-debug instrumentation (breakpoint/watch): romdev_debug.c into the
# r4300 dir + hook write_rdram_dram (write watch) + the pure_interp step (pc-break
# + coverage).
if [ ! -f mupen64plus-core/src/r4300/romdev_debug.c ]; then
  cp "$SCRIPT_DIR/patches/romdev-snippets/n64-debug.c" mupen64plus-core/src/r4300/romdev_debug.c
  sed -i 's|\$(CORE_DIR)/src/r4300/r4300.c \\|$(CORE_DIR)/src/r4300/r4300.c \\\n\t$(CORE_DIR)/src/r4300/romdev_debug.c \\|' Makefile.common
  sed -i 's|int write_rdram_dram(void\* opaque, uint32_t address, uint32_t value, uint32_t mask)\n{|extern void romdev_on_write(unsigned int,unsigned int,unsigned int);\nint write_rdram_dram(void* opaque, uint32_t address, uint32_t value, uint32_t mask)\n{\n    romdev_on_write(address, value, 0);|' mupen64plus-core/src/ri/rdram.c
  # (the rdram sed spans lines; use perl for the multiline match)
  perl -0pi -e 's/int write_rdram_dram\(void\* opaque, uint32_t address, uint32_t value, uint32_t mask\)\n\{/extern void romdev_on_write(unsigned int,unsigned int,unsigned int);\nint write_rdram_dram(void* opaque, uint32_t address, uint32_t value, uint32_t mask)\n{\n    romdev_on_write(address, value, 0);/ unless /romdev_on_write/' mupen64plus-core/src/ri/rdram.c
  perl -0pi -e 's/void pure_interpreter\(void\)\n\{/extern int romdev_on_step(unsigned int);\nextern int stop;\nvoid pure_interpreter(void)\n{/ unless /romdev_on_step/' mupen64plus-core/src/r4300/pure_interp.c
  perl -0pi -e 's/     InterpretOpcode\(\);\n   \}/     if (romdev_on_step(PC->addr)) { stop = 1; break; }\n     InterpretOpcode();\n   }/ unless /romdev_on_step\(PC/' mupen64plus-core/src/r4300/pure_interp.c
  rm -f mupen64plus-core/src/ri/rdram.o mupen64plus-core/src/r4300/pure_interp.o
fi

# romdev N64 AI register reader (getAudioState chip:'ai').
if ! grep -q "romdev_ai_get" mupen64plus-core/src/plugin/audio_libretro/audio_backend_libretro.c; then
  cat >> mupen64plus-core/src/plugin/audio_libretro/audio_backend_libretro.c <<'AIEOF'

/* romdev: copy the N64 AI registers + VI clock for getAudioState chip:'ai'. */
#include <emscripten.h>
extern struct device g_dev;
EMSCRIPTEN_KEEPALIVE void romdev_ai_get(unsigned int *out) {
   int i; for (i = 0; i < AI_REGS_COUNT; i++) out[i] = g_dev.ai.regs[i];
   out[AI_REGS_COUNT] = g_dev.ai.vi ? g_dev.ai.vi->clock : 0;
}
AIEOF
  rm -f mupen64plus-core/src/plugin/audio_libretro/audio_backend_libretro.o
fi

emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 clean >/dev/null 2>&1 || true
emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 -j"$(nproc)"

CORE_A="$SRC/parallel_n64_libretro_emscripten.bc"
cp "$CORE_A" "${CORE_A%.bc}.a"; CORE_A="${CORE_A%.bc}.a"

# Extra libretro-common sources the Makefile misses for the emscripten target.
INCLUDES="-I./libretro-common/include -I./mupen64plus-core/src -I./mupen64plus-core/src/api -I./libretro"
DEFINES="-DNDEBUG -DNO_ASM -DNOSSE -DEMSCRIPTEN -DSINC_LOWER_QUALITY -DHAVE_OPENGLES -DHAVE_OPENGLES2"
EXTRAS="
  libretro-common/audio/resampler/audio_resampler.c
  libretro-common/audio/resampler/drivers/sinc_resampler.c
  libretro-common/audio/resampler/drivers/nearest_resampler.c
  libretro-common/audio/resampler/drivers/null_resampler.c
  libretro-common/audio/conversion/float_to_s16.c
  libretro-common/audio/conversion/s16_to_float.c
  libretro-common/gfx/gl_capabilities.c
  libretro-common/features/features_cpu.c
  libretro-common/file/config_file.c
  libretro-common/file/config_file_userdata.c
  libretro-common/file/file_path.c
  libretro-common/lists/string_list.c
  libretro-common/string/stdstring.c
  libretro-common/compat/compat_strl.c
  libretro-common/compat/compat_posix_string.c
  libretro-common/compat/compat_strcasestr.c
  libretro-common/compat/compat_snprintf.c
  libretro-common/encodings/encoding_utf.c
  libretro-common/vfs/vfs_implementation.c
  libretro-common/streams/file_stream.c"
for src in $EXTRAS; do
  [ -f "$src" ] && emcc -O3 -flto -c "$src" -o "${src%.c}.o" $INCLUDES $DEFINES 2>/dev/null \
    && emar rcs "$CORE_A" "${src%.c}.o" 2>/dev/null
done

EXPORTED='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_cheat_reset","_retro_cheat_set","_romdev_mips_regs_get","_romdev_watchpoint_set","_romdev_watchpoint_set_cond","_romdev_watchpoint_get","_romdev_readwatch_set","_romdev_readwatch_get","_romdev_pcbreak_set","_romdev_pcbreak_get","_romdev_range_set","_romdev_range_get","_romdev_cov_set","_romdev_cov_get","_romdev_regsnap_get","_romdev_watchdog_set","_romdev_ai_get","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RT='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

emcc "$CORE_A" -O3 -flto -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_parallel_n64" -s "ENVIRONMENT=node,web" -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=167772160 -s MAXIMUM_MEMORY=536870912 -s STACK_SIZE=1048576 -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED" -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RT" \
  -s FILESYSTEM=1 -s INVOKE_RUN=0 -s USE_ZLIB=1 -s MIN_WEBGL_VERSION=2 -s FULL_ES3=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -o "$OUT/parallel_n64_libretro.js"

# Expose Emscripten's internal GL object on Module so the host can call
# GL.createContext()/makeContextCurrent() from outside the closure.
sed -i 's/var GL={/var GL=Module.GL={/' "$OUT/parallel_n64_libretro.js"

echo "Built: $OUT/parallel_n64_libretro.{js,wasm}"
