# romdev WASM build image — pins the exact Emscripten + system toolchain so
# rebuilding any bundled core/compiler is reproducible on any machine, instead
# of depending on whatever emcc happens to be installed locally.
#
# Pinned to Emscripten 4.0.18 (the version the shipped WASM was built with).
# Bump deliberately + rebuild + retest when upgrading; WASM output is not
# bit-reproducible across emcc versions, so a bump is a real change.
#
# Covers the "light" builds: all emulator cores + the cc65/sdcc/asar/dasm/
# vasm/rgbds toolchains (emcc + a Makefile/cmake). The heavy gcc-family
# cross-toolchains (arm-gcc for GBA, m68k-gcc for Genesis-C) need a native
# cross-gcc bootstrap and are NOT covered here yet — follow-up image.
FROM emscripten/emsdk:4.0.18

# System deps the build scripts require beyond what emsdk ships.
# emsdk already provides: emcc/emcmake/emar, git, make, cmake, python3, node.
# Added: bison + flex (rgbds parser; sdcc autoconf), curl + tar + xz (sdcc
# release fetch), build-essential (native host bits some configures probe).
#
# zlib1g-dev: SDCC builds in TWO passes and BOTH need zlib, by different
# mechanisms. The NATIVE pass (./configure, plain gcc) probes for zlib.h in
# /usr/include — that's what zlib1g-dev provides. The EMSCRIPTEN pass
# (emconfigure) probes the WASM sysroot — satisfied separately by emscripten's
# zlib port (-s USE_ZLIB=1 in build-sdcc.sh). Removing zlib1g-dev breaks the
# native pass; dropping USE_ZLIB breaks the emscripten pass. Both are required.
# libboost-dev: SDCC's native pass also needs Boost.Graph headers
# (boost/graph/adjacency_list.hpp) for its register allocator — it's mandatory,
# there is no --disable-boost. Same story as zlib: the dev box had system boost,
# so this passed silently there; the clean container surfaced it. The
# emscripten pass gets boost via emcc's port (-s USE_BOOST_HEADERS=1); the
# native pass needs the system headers. libboost-graph-dev pulls libboost-dev.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bison \
      flex \
      curl \
      tar \
      xz-utils \
      build-essential \
      ca-certificates \
      zlib1g-dev \
      libboost-graph-dev \
 && rm -rf /var/lib/apt/lists/*

# Builds run against a bind-mounted repo at /work (see build-wasm.sh). EMSDK is
# already exported by the base image, so scripts/_lib.sh sources emsdk_env.sh
# automatically.
WORKDIR /work

# Default: print usage. Real use is `docker run ... <build-script>` via
# build-image/build-wasm.sh.
CMD ["bash", "-lc", "echo 'romdev wasm builder (emscripten 4.0.18). Run a build script, e.g.: bash scripts/build-dasm.sh'"]
